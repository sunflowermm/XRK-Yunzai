#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Python插件桥接器
负责管理Python插件的加载和JavaScript通信
"""

import sys
import json
import os
import traceback
import importlib.util
import asyncio
from pathlib import Path
from typing import Any, Dict, List, Optional
import signal
import logging

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class PluginBase:
    """Python插件基类"""
    
    def __init__(self):
        self.name = self.__class__.__name__
        self.priority = 50
        self.rule = []
        self.task = []
        self.e = None
    
    async def accept(self, e: Dict) -> bool:
        """接受事件处理"""
        return False


class PluginLoader:
    """插件加载器"""
    
    def __init__(self, plugins_dir: str):
        """
        初始化插件加载器
        :param plugins_dir: 插件目录路径
        """
        self.plugins_dir = Path(plugins_dir)
        self.plugins = {}
        self.instances = {}
    
    def load_all(self) -> None:
        """加载所有插件"""
        if not self.plugins_dir.exists():
            logger.warning(f"插件目录不存在: {self.plugins_dir}")
            return
        
        for item in self.plugins_dir.iterdir():
            if item.is_file() and item.suffix == '.py':
                self._load_file(item)
            elif item.is_dir() and not item.name.startswith('__'):
                self._load_directory(item)
    
    def _load_directory(self, dir_path: Path) -> None:
        """
        加载目录中的插件
        :param dir_path: 目录路径
        """
        # 优先加载 index.py
        index_file = dir_path / 'index.py'
        if index_file.exists():
            self._load_file(index_file)
        else:
            # 加载目录中的所有 .py 文件
            for py_file in dir_path.glob('*.py'):
                if not py_file.name.startswith('__'):
                    self._load_file(py_file)
    
    def _load_file(self, file_path: Path) -> None:
        """
        加载单个插件文件
        :param file_path: 文件路径
        """
        try:
            # 构造模块名
            relative_path = file_path.relative_to(self.plugins_dir)
            module_name = str(relative_path).replace('/', '.').replace('.py', '')
            
            # 动态导入模块
            spec = importlib.util.spec_from_file_location(module_name, file_path)
            if not spec or not spec.loader:
                return
            
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            
            # 查找插件类
            for attr_name in dir(module):
                attr = getattr(module, attr_name)
                if (isinstance(attr, type) and 
                    issubclass(attr, PluginBase) and 
                    attr != PluginBase):
                    
                    plugin_key = str(relative_path)
                    self.plugins[plugin_key] = attr
                    
                    # 创建实例获取元信息
                    instance = attr()
                    
                    # 发送插件注册消息
                    self._send_message({
                        'type': 'plugin_registered',
                        'data': {
                            'key': plugin_key,
                            'name': instance.name,
                            'priority': instance.priority,
                            'rule': self._serialize_rules(instance.rule),
                            'task': instance.task
                        }
                    })
                    
                    logger.info(f"已加载插件: {plugin_key} [{instance.name}]")
                    
        except Exception as e:
            logger.error(f"加载插件失败 {file_path}: {e}")
            logger.debug(traceback.format_exc())
    
    def _serialize_rules(self, rules: List) -> List[Dict]:
        """
        序列化插件规则
        :param rules: 规则列表
        :return: 序列化后的规则
        """
        serialized = []
        for rule in rules:
            if isinstance(rule, dict):
                serialized.append(rule)
            else:
                # 处理自定义规则对象
                serialized.append({
                    'reg': getattr(rule, 'reg', None),
                    'fnc': getattr(rule, 'fnc', ''),
                    'event': getattr(rule, 'event', 'message'),
                    'log': getattr(rule, 'log', True),
                    'permission': getattr(rule, 'permission', 'all')
                })
        return serialized
    
    async def call_method(self, plugin_key: str, method: str, args: List) -> Any:
        """
        调用插件方法
        :param plugin_key: 插件键
        :param method: 方法名
        :param args: 参数列表
        :return: 方法返回值
        """
        if plugin_key not in self.plugins:
            raise ValueError(f"插件不存在: {plugin_key}")
        
        # 获取或创建实例
        if plugin_key not in self.instances:
            self.instances[plugin_key] = self.plugins[plugin_key]()
        
        instance = self.instances[plugin_key]
        
        # 设置事件数据
        if args and isinstance(args[0], dict):
            instance.e = args[0]
        
        # 获取方法
        if not hasattr(instance, method):
            raise ValueError(f"方法不存在: {method}")
        
        func = getattr(instance, method)
        
        # 调用方法
        if asyncio.iscoroutinefunction(func):
            return await func(*args)
        else:
            return func(*args)
    
    def _send_message(self, message: Dict) -> None:
        """
        发送消息到Node.js
        :param message: 消息字典
        """
        try:
            print(json.dumps(message), flush=True)
        except Exception as e:
            logger.error(f"发送消息失败: {e}")


class MessageHandler:
    """消息处理器"""
    
    def __init__(self, loader: PluginLoader):
        """
        初始化消息处理器
        :param loader: 插件加载器
        """
        self.loader = loader
        self.running = True
    
    async def handle(self, message: Dict) -> None:
        """
        处理接收的消息
        :param message: 消息字典
        """
        msg_type = message.get('type')
        msg_id = message.get('id')
        
        try:
            if msg_type == 'call':
                # 调用插件方法
                result = await self.loader.call_method(
                    message['plugin'],
                    message['method'],
                    message.get('args', [])
                )
                
                # 返回结果
                self._send_response(msg_id, {'result': result})
                
            elif msg_type == 'shutdown':
                self.running = False
                
        except Exception as e:
            # 返回错误
            self._send_response(msg_id, {'error': str(e)})
            logger.error(f"处理消息错误: {e}")
            logger.debug(traceback.format_exc())
    
    def _send_response(self, msg_id: Any, data: Dict) -> None:
        """
        发送响应消息
        :param msg_id: 消息ID
        :param data: 响应数据
        """
        self.loader._send_message({
            'type': 'response',
            'id': msg_id,
            'data': data
        })
    
    async def run(self) -> None:
        """运行消息循环"""
        # 发送就绪信号
        self.loader._send_message({'type': 'ready'})
        
        # 读取输入
        loop = asyncio.get_event_loop()
        
        while self.running:
            try:
                # 异步读取标准输入
                line = await loop.run_in_executor(None, sys.stdin.readline)
                
                if not line:
                    break
                
                line = line.strip()
                if not line:
                    continue
                
                try:
                    message = json.loads(line)
                    await self.handle(message)
                except json.JSONDecodeError:
                    logger.error(f"无效的JSON: {line}")
                    
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"消息循环错误: {e}")


async def main():
    """主函数"""
    # 解析命令行参数
    plugins_dir = 'plugins/python'
    for i, arg in enumerate(sys.argv):
        if arg == '--plugins-dir' and i + 1 < len(sys.argv):
            plugins_dir = sys.argv[i + 1]
    
    # 创建加载器
    loader = PluginLoader(plugins_dir)
    
    # 加载所有插件
    loader.load_all()
    
    # 创建处理器
    handler = MessageHandler(loader)
    
    # 运行消息循环
    await handler.run()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as e:
        logger.error(f"运行时错误: {e}")
        sys.exit(1)