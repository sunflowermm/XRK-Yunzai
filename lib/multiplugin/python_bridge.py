#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import json
import os
import re
import traceback
import importlib.util
import asyncio
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional, Pattern
import signal

# 设置路径
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "plugins" / "python"))

@dataclass
class PluginRule:
    """插件规则"""
    reg: Optional[str] = None
    fnc: str = ""
    event: str = "message"
    log: bool = True
    permission: str = "all"
    
    def __post_init__(self):
        if self.reg:
            self.pattern = re.compile(self.reg)
        else:
            self.pattern = None

@dataclass
class PluginInfo:
    """插件信息"""
    name: str
    priority: int = 50
    rule: List[PluginRule] = None
    task: List[Dict] = None
    language: str = "python"
    
class PythonPlugin:
    """Python插件基类"""
    
    def __init__(self):
        self.name = self.__class__.__name__
        self.priority = 50
        self.rule = []
        self.task = []
        self.e = None
        
    async def accept(self, e):
        """接受事件处理"""
        return False
        
    def check_rule(self, e, rule: PluginRule):
        """检查规则匹配"""
        if rule.pattern and e.get('msg'):
            return rule.pattern.search(e['msg'])
        return True

class PluginManager:
    """插件管理器"""
    
    def __init__(self):
        self.plugins = {}
        self.instances = {}
        
    def load_plugins(self, plugins_dir: str):
        """加载插件目录"""
        plugins_path = Path(plugins_dir)
        
        if not plugins_path.exists():
            return
            
        for folder in plugins_path.iterdir():
            if folder.is_dir() and not folder.name.startswith('__'):
                self.load_plugin_folder(folder)
                
    def load_plugin_folder(self, folder: Path):
        """加载插件文件夹"""
        # 查找主文件
        main_file = folder / "index.py"
        if not main_file.exists():
            # 扫描所有py文件
            for py_file in folder.glob("*.py"):
                if not py_file.name.startswith('__'):
                    self.load_plugin_file(py_file)
        else:
            self.load_plugin_file(main_file)
            
    def load_plugin_file(self, file_path: Path):
        """加载插件文件"""
        try:
            # 动态导入模块
            spec = importlib.util.spec_from_file_location(
                file_path.stem,
                file_path
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            
            # 查找插件类
            for name in dir(module):
                obj = getattr(module, name)
                if (isinstance(obj, type) and 
                    issubclass(obj, PythonPlugin) and 
                    obj != PythonPlugin):
                    
                    plugin_key = f"{file_path.parent.name}/{file_path.name}"
                    self.plugins[plugin_key] = obj
                    
                    # 创建实例获取信息
                    instance = obj()
                    
                    # 发送插件信息
                    info = {
                        "type": "plugin_loaded",
                        "data": {
                            "key": plugin_key,
                            "name": instance.name,
                            "priority": instance.priority,
                            "rule": [asdict(r) if isinstance(r, PluginRule) else r 
                                    for r in instance.rule],
                            "task": instance.task,
                            "language": "python"
                        }
                    }
                    send_message(info)
                    
                    log_message(f"加载插件: {plugin_key} [{instance.name}]")
                    
        except Exception as e:
            log_message(f"加载插件失败 {file_path}: {e}", "error")
            
    async def call_plugin(self, plugin_name: str, method: str, args: List[Any]):
        """调用插件方法"""
        if plugin_name not in self.plugins:
            raise ValueError(f"插件不存在: {plugin_name}")
            
        # 获取或创建实例
        if plugin_name not in self.instances:
            self.instances[plugin_name] = self.plugins[plugin_name]()
            
        instance = self.instances[plugin_name]
        
        # 设置事件数据
        if args and isinstance(args[0], dict):
            instance.e = args[0]
            
        # 调用方法
        if not hasattr(instance, method):
            raise ValueError(f"方法不存在: {method}")
            
        func = getattr(instance, method)
        
        # 处理异步方法
        if asyncio.iscoroutinefunction(func):
            return await func(*args)
        else:
            return func(*args)

class MessageHandler:
    """消息处理器"""
    
    def __init__(self, plugin_manager: PluginManager):
        self.plugin_manager = plugin_manager
        self.running = True
        
    async def handle_message(self, message: Dict):
        """处理消息"""
        msg_type = message.get('type')
        msg_id = message.get('id')
        
        try:
            if msg_type == 'call':
                # 调用插件
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
                self.running = False
                
        except Exception as e:
            # 返回错误
            send_message({
                'id': msg_id,
                'type': 'response',
                'data': {
                    'error': str(e)
                }
            })
            
    async def run(self):
        """运行消息循环"""
        loop = asyncio.get_event_loop()
        
        # 设置信号处理
        for sig in [signal.SIGTERM, signal.SIGINT]:
            signal.signal(sig, lambda s, f: self.stop())
            
        # 发送就绪信号
        send_message({'type': 'ready'})
        
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
                    
                try:
                    message = json.loads(line)
                    await self.handle_message(message)
                except json.JSONDecodeError:
                    log_message(f"无效的JSON: {line}", "error")
                    
            except KeyboardInterrupt:
                break
            except Exception as e:
                log_message(f"处理消息错误: {e}", "error")
                
    def stop(self):
        """停止运行"""
        self.running = False

def send_message(message: Dict):
    """发送消息到Node.js"""
    try:
        print(json.dumps(message), flush=True)
    except Exception as e:
        sys.stderr.write(f"发送消息失败: {e}\n")
        
def log_message(message: str, level: str = "info"):
    """发送日志消息"""
    send_message({
        'type': 'log',
        'data': {
            'level': level,
            'message': message
        }
    })

async def main():
    """主函数"""
    # 解析参数
    plugins_dir = "plugins/python"
    for i, arg in enumerate(sys.argv):
        if arg == "--plugins-dir" and i + 1 < len(sys.argv):
            plugins_dir = sys.argv[i + 1]
            
    # 创建管理器
    plugin_manager = PluginManager()
    
    # 加载插件
    plugin_manager.load_plugins(plugins_dir)
    
    # 创建处理器
    handler = MessageHandler(plugin_manager)
    
    # 运行
    await handler.run()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        sys.stderr.write(f"运行时错误: {e}\n")
        sys.exit(1)