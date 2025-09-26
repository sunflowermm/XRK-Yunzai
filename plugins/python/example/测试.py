#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
示例Python插件
展示Python插件的基本结构和功能
"""

import re
import json
import random
from typing import Dict, Any, Optional
from datetime import datetime

# 导入插件基类
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent.parent.parent / "lib" / "multiplugin" / "bridges"))
from python_bridge import PythonPlugin, PluginRule, PluginTask

class ExamplePlugin(PythonPlugin):
    """
    示例插件类
    展示基础功能实现
    """
    
    def __init__(self):
        super().__init__()
        self.name = "Python示例插件"
        self.priority = 50
        
        # 定义规则
        self.rule = [
            PluginRule(
                reg=r"^#?py测试$",
                fnc="test_command",
                event="message",
                log=True
            ),
            PluginRule(
                reg=r"^#?py计算\s+(.+)$",
                fnc="calculate",
                event="message",
                log=True
            ),
            PluginRule(
                reg=r"^#?py状态$",
                fnc="status",
                event="message",
                permission="all"
            )
        ]
        
        # 定义定时任务
        self.task = [
            PluginTask(
                cron="0 */30 * * * ?",  # 每30分钟
                fnc="scheduled_task",
                name="Python定时任务示例",
                log=True
            )
        ]
        
        # 插件数据
        self.data = {
            "call_count": 0,
            "last_call": None
        }
    
    async def test_command(self, e: Dict) -> Dict:
        """
        测试命令处理
        @param e: 事件对象
        @return: 响应内容
        """
        self.data["call_count"] += 1
        self.data["last_call"] = datetime.now().isoformat()
        
        msg = f"""🐍 **Python插件测试**
━━━━━━━━━━━━━━━
✅ 插件运行正常
📊 调用次数: {self.data['call_count']}
⏰ 当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
👤 用户ID: {e.get('user_id', '未知')}
💬 消息: {e.get('msg', '无')}"""
        
        return {
            "reply": msg,
            "at": e.get('user_id') if e.get('isGroup') else False
        }
    
    async def calculate(self, e: Dict) -> Dict:
        """
        计算功能
        @param e: 事件对象
        @return: 计算结果
        """
        msg = e.get('msg', '')
        
        # 提取表达式
        match = re.search(r'py计算\s+(.+)$', msg)
        if not match:
            return {"reply": "请提供计算表达式"}
        
        expr = match.group(1).strip()
        
        try:
            # 安全计算（只允许基本运算）
            allowed_chars = '0123456789+-*/()., '
            if not all(c in allowed_chars for c in expr):
                return {"reply": "❌ 表达式包含不允许的字符"}
            
            # 计算结果
            result = eval(expr)
            
            return {
                "reply": f"🧮 计算结果:\n{expr} = {result}"
            }
            
        except Exception as e:
            return {
                "reply": f"❌ 计算错误: {str(e)}"
            }
    
    async def status(self, e: Dict) -> Dict:
        """
        获取插件状态
        @param e: 事件对象
        @return: 状态信息
        """
        import platform
        import os
        
        # 收集系统信息
        info = {
            "Python版本": platform.python_version(),
            "系统": platform.system(),
            "架构": platform.machine(),
            "进程ID": os.getpid(),
            "调用统计": f"{self.data['call_count']}次",
            "最后调用": self.data['last_call'] or "无"
        }
        
        msg = "📊 **Python插件状态**\n"
        msg += "━━━━━━━━━━━━━━━\n"
        for key, value in info.items():
            msg += f"▪ {key}: {value}\n"
        
        return {"reply": msg}
    
    async def scheduled_task(self) -> Dict:
        """
        定时任务
        @return: 任务结果
        """
        return {
            "message": f"Python定时任务执行 - {datetime.now()}"
        }
    
    async def accept(self, e: Dict) -> Any:
        """
        接受事件预处理
        @param e: 事件对象
        @return: 是否继续处理
        """
        # 可以在这里进行预处理
        # 返回 True 表示独占处理
        # 返回 'return' 表示处理完成，不再继续
        # 返回 False 表示继续处理
        return False
    
    async def handleNonMatchMsg(self, e: Dict) -> Any:
        """
        处理未匹配的消息
        @param e: 事件对象
        @return: 处理结果
        """
        # 这里可以处理没有匹配任何规则的消息
        # 通常用于实现默认回复或智能对话
        return False

class AdvancedPlugin(PythonPlugin):
    """
    高级功能示例插件
    展示更复杂的功能
    """
    
    def __init__(self):
        super().__init__()
        self.name = "Python高级插件"
        self.priority = 45
        
        self.rule = [
            PluginRule(
                reg=r"^#?py帮助$",
                fnc="show_help",
                event="message"
            ),
            PluginRule(
                reg=r"^#?py随机\s*(\d+)?$",
                fnc="random_number",
                event="message"
            )
        ]
        
        # 绕过节流限制
        self.bypassThrottle = True
        
    async def show_help(self, e: Dict) -> Dict:
        """
        显示帮助信息
        """
        help_text = """📚 **Python插件帮助**
━━━━━━━━━━━━━━━
可用命令：
• #py测试 - 测试插件运行
• #py计算 <表达式> - 计算数学表达式
• #py状态 - 查看插件状态
• #py帮助 - 显示此帮助
• #py随机 [最大值] - 生成随机数

💡 Python插件支持：
- 异步处理
- 定时任务
- 复杂数据处理
- 第三方库集成"""
        
        return {"reply": help_text}
    
    async def random_number(self, e: Dict) -> Dict:
        """
        生成随机数
        """
        msg = e.get('msg', '')
        
        # 提取最大值
        match = re.search(r'py随机\s*(\d+)?$', msg)
        max_val = 100  # 默认值
        
        if match and match.group(1):
            max_val = int(match.group(1))
            
        # 生成随机数
        result = random.randint(1, max_val)
        
        # 特殊数字彩蛋
        emoji = "🎲"
        if result == 1:
            emoji = "😅"
        elif result == max_val:
            emoji = "🎯"
        elif result == 42:
            emoji = "🌟"
            
        return {
            "reply": f"{emoji} 随机数: {result} (范围: 1-{max_val})"
        }

# 导出插件类
__all__ = ['ExamplePlugin', 'AdvancedPlugin']