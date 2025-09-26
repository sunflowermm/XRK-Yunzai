#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Python插件桥接器
负责Python插件的加载、管理和与Node.js的通信
"""

import sys
import json
import os
import traceback
import asyncio
import importlib.util
import signal
from pathlib import Path
from typing import Any, Dict, List, Optional, Type
from dataclasses import dataclass, asdict, field
import logging

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 添加插件路径
PLUGIN_PATH = Path(__file__).parent.parent.parent / "plugins" / "python"
sys.path.insert(0, str(PLUGIN_PATH))

@dataclass
class PluginRule:
    """插件规则定义"""
    reg: Optional[str] = None
    fnc: str = ""
    event: str = "message"
    log: bool = True
    permission: str = "all"
    
    def to_dict(self):
        """转换为字典"""
        return {k: v for k, v in asdict(self).items() if v is not None}

@dataclass
class PluginTask:
    """插件定时任务"""
    cron: str
    fnc: str
    name: Optional[str] = None
    log: bool = True
    
    def to_dict(self):
        """转换为字典"""
        return asdict(self)

class PythonPlugin:
    """Python插件基类"""
    
    def __init__(self):
        self.name: str = self.__class__.__name__
        self.priority: int = 50
        self.rule: List[PluginRule] = []
        self.task: List[PluginTask] = []
        self.bypassThrottle: bool = False
        self.e: Optional[Dict] = None
        
    async def accept(self, e: Dict) -> Any:
        """
        接受事件处理
        @param e: 事件对象
        @return: False/True/'return'
        """
        return False
        
    async def handleNonMatchMsg(self, e: Dict) -> Any:
        """
        处理未匹配消息
        @param e: 事件对象
        @return: 处理结果
        """
        return False

class PluginManager:
    """插件管理器"""
    
    def __init__(self):
        self.plugins: Dict[str, Type[PythonPlugin]] = {}
        self.instances: Dict[str, PythonPlugin] = {}
        self.loaded_modules: Dict[str, Any] = {}
        
    def scan_plugins(self, plugins_dir: Path) -> None:
        """
        扫描并加载插件目录
        @param plugins_dir: 插件目录路径
        """
        if not plugins_dir.exists():
            logger.warning(f"插件目录不存在: {plugins_dir}")
            return
            
        logger.info(f"扫描插件目录: {plugins_dir}")
        
        # 遍历所有子目录
        for item in plugins_dir.iterdir():
            if item.is_dir() and not item.name.startswith('__'):
                self._load_plugin_folder(item)
                
    def _load_plugin_folder(self, folder: Path) -> None:
        """
        加载插件文件夹
        @param folder: 文件夹路径
        """
        # 优先加载index.py
        index_file = folder / "index.py"
        if index_file.exists():
            self._load_plugin_file(index_file, folder.name)
        else:
            # 加载所有.py文件
            for py_file in folder.glob("*.py"):
                if not py_file.name.startswith('__'):
                    self._load_plugin_file(py_file, folder.name)
                    
    def _load_plugin_file(self, file_path: Path, folder_name: str) -> None:
        """
        加载单个插件文件
        @param file_path: 文件路径
        @param folder_name: 文件夹名称
        """
        try:
            # 创建模块规范
            module_name = f"{folder_name}.{file_path.stem}"
            spec = importlib.util.spec_from_file_location(module_name, file_path)
            if not spec or not spec.loader:
                return
                
            # 加载模块
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.loaded_modules[module_name] = module
            
            # 查找插件类
            for attr_name in dir(module):
                attr = getattr(module, attr_name)
                
                # 检查是否为插件类
                if (isinstance(attr, type) and 
                    issubclass(attr, PythonPlugin) and 
                    attr != PythonPlugin):
                    
                    # 生成插件键
                    plugin_key = f"{folder_name}/{file_path.name}"
                    self.plugins[plugin_key] = attr
                    
                    # 创建实例获取元数据
                    instance = attr()
                    
                    # 发送插件注册消息
                    self._send_plugin_registered(plugin_key, instance)
                    
                    logger.info(f"加载插件: {plugin_key} [{instance.name}]")
                    
        except Exception as e:
            logger.error(f"加载插件失败 {file_path}: {e}")
            logger.error(traceback.format_exc())
            
    def _send_plugin_registered(self, key: str, instance: PythonPlugin) -> None:
        """
        发送插件注册消息
        @param key: 插件键
        @param instance: 插件实例
        """
        # 准备插件信息
        plugin_info = {
            "key": key,
            "name": instance.name,
            "priority": instance.priority,
            "bypassThrottle": instance.bypassThrottle,
            "rule": [r.to_dict() if hasattr(r, 'to_dict') else r 
                    for r in instance.rule],
            "task": [t.to_dict() if hasattr(t, 'to_dict') else t 
                    for t in instance.task]
        }
        
        # 发送消息
        send_message({
            "type": "plugin_registered",
            "data": plugin_info
        })
        
    async def call_plugin(self, plugin_key: str, method: str, args: List[Any]) -> Any:
        """
        调用插件方法
        @param plugin_key: 插件键
        @param method: 方法名
        @param args: 参数列表
        @return: 调用结果
        """
        # 获取插件类
        plugin_class = self.plugins.get(plugin_key)
        if not plugin_class:
            raise ValueError(f"插件不存在: {plugin_key}")
            
        # 获取或创建实例
        if plugin_key not in self.instances:
            self.instances[plugin_key] = plugin_class()
            
        instance = self.instances[plugin_key]
        
        # 设置事件上下文
        if args and isinstance(args[0], dict):
            instance.e = args[0]
            
        # 获取方法
        if not hasattr(instance, method):
            raise ValueError(f"方法不存在: {plugin_key}.{method}")
            
        func = getattr(instance, method)
        
        # 调用方法
        if asyncio.iscoroutinefunction(func):
            result = await func(*args)
        else:
            result = func(*args)
            
        return result

class MessageHandler:
    """消息处理器"""
    
    def __init__(self, plugin_manager: PluginManager):
        self.plugin_manager = plugin_manager
        self.running = True
        
    async def handle_message(self, message: Dict) -> None:
        """
        处理来自Node.js的消息
        @param message: 消息对象
        """
        msg_type = message.get('type')
        msg_id = message.get('id')
        
        try:
            if msg_type == 'load_plugins':
                # 加载插件
                plugins_dir = Path(message['data']['dir'])
                self.plugin_manager.scan_plugins(plugins_dir)
                
            elif msg_type == 'call':
                # 调用插件方法
                result = await self.plugin_manager.call_plugin(
                    message['plugin'],
                    message['method'],
                    message.get('args', [])
                )
                
                # 返回结果
                send_message({
                    'id': msg_id,
                    'type': 'response',
                    'data': {
                        'value': result
                    }
                })
                
            elif msg_type == 'shutdown':
                # 关闭运行时
                self.running = False
                
        except Exception as e:
            # 返回错误
            if msg_id:
                send_message({
                    'id': msg_id,
                    'type': 'response',
                    'data': {
                        'error': str(e)
                    }
                })
            logger.error(f"处理消息错误: {e}")
            logger.error(traceback.format_exc())
            
    async def run(self) -> None:
        """运行消息循环"""
        loop = asyncio.get_event_loop()
        
        # 设置信号处理
        for sig in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(sig, lambda s, f: self.stop())
            
        # 发送就绪信号
        send_message({'type': 'ready'})
        log_message("Python运行时已就绪", "info")
        
        # 消息循环
        while self.running:
            try:
                # 异步读取输入
                line = await loop.run_in_executor(None, sys.stdin.readline)
                
                if not line:
                    break
                    
                line = line.strip()
                if not line:
                    continue
                    
                # 解析JSON消息
                try:
                    message = json.loads(line)
                    await self.handle_message(message)
                except json.JSONDecodeError as e:
                    logger.error(f"JSON解析错误: {e}")
                    
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"消息循环错误: {e}")
                logger.error(traceback.format_exc())
                
    def stop(self) -> None:
        """停止运行"""
        self.running = False
        log_message("Python运行时正在关闭", "info")

def send_message(message: Dict) -> None:
    """
    发送消息到Node.js
    @param message: 消息对象
    """
    try:
        print(json.dumps(message, ensure_ascii=False), flush=True)
    except Exception as e:
        sys.stderr.write(f"发送消息失败: {e}\n")
        
def log_message(message: str, level: str = "info") -> None:
    """
    发送日志消息
    @param message: 日志内容
    @param level: 日志级别
    """
    send_message({
        'type': 'log',
        'data': {
            'level': level,
            'message': message
        }
    })

async def main() -> None:
    """主函数"""
    # 解析参数
    plugins_dir = Path("plugins/python")
    for i, arg in enumerate(sys.argv):
        if arg == "--plugins-dir" and i + 1 < len(sys.argv):
            plugins_dir = Path(sys.argv[i + 1])
            
    # 创建管理器
    plugin_manager = PluginManager()
    
    # 创建消息处理器
    handler = MessageHandler(plugin_manager)
    
    # 运行主循环
    try:
        await handler.run()
    except Exception as e:
        logger.error(f"运行时错误: {e}")
        logger.error(traceback.format_exc())
        sys.exit(1)

if __name__ == "__main__":
    # 运行主程序
    asyncio.run(main())