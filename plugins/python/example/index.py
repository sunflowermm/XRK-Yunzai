#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
示例Python插件
展示如何编写Python插件
"""

import re
import json
import random
from datetime import datetime
from pathlib import Path

# 导入插件基类
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))))
from lib.multiplugin.bridge import PluginBase


class ExamplePlugin(PluginBase):
    """示例Python插件"""
    
    def __init__(self):
        super().__init__()
        self.name = "Python示例插件"
        self.priority = 50
        
        # 定义规则
        self.rule = [
            {
                'reg': r'^#?py测试$',
                'fnc': 'test',
                'event': 'message',
                'log': True
            },
            {
                'reg': r'^#?py计算\s+(.+)$',
                'fnc': 'calculate',
                'event': 'message'
            },
            {
                'reg': r'^#?py时间$',
                'fnc': 'show_time',
                'event': 'message'
            },
            {
                'reg': r'^#?py随机数\s*(\d+)?$',
                'fnc': 'random_number',
                'event': 'message'
            }
        ]
        
        # 定义定时任务
        self.task = [
            {
                'cron': '0 0 * * * *',  # 每小时执行
                'fnc': 'hourly_task',
                'log': True
            }
        ]
    
    async def test(self, *args):
        """测试命令"""
        return {
            'reply': '✅ Python插件运行正常！'
        }
    
    async def calculate(self, *args):
        """计算表达式"""
        e = self.e
        msg = e.get('msg', '')
        
        # 提取表达式
        match = re.search(r'py计算\s+(.+)$', msg)
        if not match:
            return {'reply': '请提供要计算的表达式'}
        
        expression = match.group(1).strip()
        
        try:
            # 安全计算表达式（只允许基本运算）
            allowed_chars = '0123456789+-*/()., '
            if all(c in allowed_chars for c in expression):
                result = eval(expression)
                return {'reply': f'计算结果: {expression} = {result}'}
            else:
                return {'reply': '表达式包含不允许的字符'}
        except Exception as e:
            return {'reply': f'计算错误: {str(e)}'}
    
    async def show_time(self, *args):
        """显示当前时间"""
        now = datetime.now()
        time_str = now.strftime('%Y-%m-%d %H:%M:%S')
        weekday = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'][now.weekday()]
        
        return {
            'reply': f'📅 当前时间：{time_str} {weekday}'
        }
    
    async def random_number(self, *args):
        """生成随机数"""
        e = self.e
        msg = e.get('msg', '')
        
        # 提取最大值
        match = re.search(r'py随机数\s*(\d+)?$', msg)
        if match and match.group(1):
            max_num = int(match.group(1))
        else:
            max_num = 100
        
        number = random.randint(1, max_num)
        
        return {
            'reply': f'🎲 随机数 (1-{max_num}): {number}'
        }
    
    async def hourly_task(self):
        """每小时执行的任务"""
        return {
            'message': f'整点报时: {datetime.now().strftime("%H:00")}'
        }


class DataProcessPlugin(PluginBase):
    """数据处理插件"""
    
    def __init__(self):
        super().__init__()
        self.name = "Python数据处理"
        self.priority = 45
        
        self.rule = [
            {
                'reg': r'^#?py统计\s+(.+)$',
                'fnc': 'statistics',
                'event': 'message'
            },
            {
                'reg': r'^#?py排序\s+(.+)$',
                'fnc': 'sort_data',
                'event': 'message'
            }
        ]
    
    async def statistics(self, *args):
        """数据统计"""
        e = self.e
        msg = e.get('msg', '')
        
        match = re.search(r'py统计\s+(.+)$', msg)
        if not match:
            return {'reply': '请提供要统计的数据（用逗号分隔）'}
        
        data_str = match.group(1).strip()
        
        try:
            # 解析数据
            data = [float(x.strip()) for x in data_str.split(',')]
            
            if not data:
                return {'reply': '没有有效数据'}
            
            # 计算统计信息
            count = len(data)
            total = sum(data)
            avg = total / count
            min_val = min(data)
            max_val = max(data)
            
            # 计算中位数
            sorted_data = sorted(data)
            if count % 2 == 0:
                median = (sorted_data[count//2 - 1] + sorted_data[count//2]) / 2
            else:
                median = sorted_data[count//2]
            
            result = f'''📊 数据统计结果：
数量: {count}
总和: {total:.2f}
平均值: {avg:.2f}
中位数: {median:.2f}
最小值: {min_val:.2f}
最大值: {max_val:.2f}'''
            
            return {'reply': result}
            
        except ValueError:
            return {'reply': '数据格式错误，请输入数字，用逗号分隔'}
        except Exception as e:
            return {'reply': f'统计错误: {str(e)}'}
    
    async def sort_data(self, *args):
        """数据排序"""
        e = self.e
        msg = e.get('msg', '')
        
        match = re.search(r'py排序\s+(.+)$', msg)
        if not match:
            return {'reply': '请提供要排序的数据（用逗号或空格分隔）'}
        
        data_str = match.group(1).strip()
        
        try:
            # 尝试解析为数字
            if ',' in data_str:
                items = data_str.split(',')
            else:
                items = data_str.split()
            
            # 尝试转换为数字
            try:
                data = [float(x.strip()) for x in items]
                sorted_data = sorted(data)
                result = ', '.join(str(x) for x in sorted_data)
            except ValueError:
                # 字符串排序
                data = [x.strip() for x in items]
                sorted_data = sorted(data)
                result = ', '.join(sorted_data)
            
            return {
                'reply': f'排序结果：{result}'
            }
            
        except Exception as e:
            return {'reply': f'排序错误: {str(e)}'}


# 导出插件类
__all__ = ['ExamplePlugin', 'DataProcessPlugin']