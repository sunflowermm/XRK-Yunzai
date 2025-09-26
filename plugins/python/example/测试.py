#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import os
import asyncio
import re
import json
import base64
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

# 添加父目录到系统路径
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))))

from lib.multiplugin.python_bridge import PythonPlugin, PluginRule

# 高级功能导入
try:
    import numpy as np
    import pandas as pd
    HAS_DATA_LIBS = True
except ImportError:
    HAS_DATA_LIBS = False

try:
    from PIL import Image, ImageDraw, ImageFont
    import matplotlib.pyplot as plt
    import matplotlib
    matplotlib.use('Agg')
    HAS_IMAGE_LIBS = True
except ImportError:
    HAS_IMAGE_LIBS = False

try:
    import aiohttp
    from bs4 import BeautifulSoup
    HAS_WEB_LIBS = True
except ImportError:
    HAS_WEB_LIBS = False

try:
    from sklearn.linear_model import LinearRegression
    from sklearn.preprocessing import StandardScaler
    HAS_ML_LIBS = True
except ImportError:
    HAS_ML_LIBS = False

try:
    import jieba
    import wordcloud
    HAS_NLP_LIBS = True
except ImportError:
    HAS_NLP_LIBS = False


class DataAnalysisPlugin(PythonPlugin):
    """数据分析插件 - 展示Python的数据处理能力"""
    
    def __init__(self):
        super().__init__()
        self.name = "Python数据分析"
        self.priority = 40
        
        self.rule = [
            PluginRule(
                reg=r"^#?py分析\s+(.+)$",
                fnc="analyze_data",
                event="message",
                log=True
            ),
            PluginRule(
                reg=r"^#?py图表\s+(.+)$",
                fnc="create_chart",
                event="message"
            ),
            PluginRule(
                reg=r"^#?py预测\s+(.+)$",
                fnc="predict",
                event="message"
            )
        ]
        
        # 缓存数据
        self.data_cache = {}
    
    async def analyze_data(self, *args):
        """数据分析功能"""
        if not HAS_DATA_LIBS:
            return {"reply": "需要安装numpy和pandas库才能使用数据分析功能"}
        
        e = self.e
        msg = e.get('msg', '')
        
        # 提取参数
        match = re.search(r'py分析\s+(.+)$', msg)
        if not match:
            return {"reply": "请提供要分析的数据（用逗号分隔）"}
        
        data_str = match.group(1).strip()
        
        try:
            # 解析数据
            data = [float(x.strip()) for x in data_str.split(',')]
            
            # 使用numpy和pandas进行分析
            arr = np.array(data)
            df = pd.DataFrame(data, columns=['value'])
            
            # 计算统计信息
            stats = {
                "数据点数": len(data),
                "平均值": f"{np.mean(arr):.2f}",
                "中位数": f"{np.median(arr):.2f}",
                "标准差": f"{np.std(arr):.2f}",
                "最小值": f"{np.min(arr):.2f}",
                "最大值": f"{np.max(arr):.2f}",
                "25%分位": f"{df['value'].quantile(0.25):.2f}",
                "75%分位": f"{df['value'].quantile(0.75):.2f}",
                "变异系数": f"{(np.std(arr) / np.mean(arr) * 100):.2f}%"
            }
            
            # 检测异常值（使用IQR方法）
            Q1 = df['value'].quantile(0.25)
            Q3 = df['value'].quantile(0.75)
            IQR = Q3 - Q1
            outliers = df[(df['value'] < Q1 - 1.5 * IQR) | (df['value'] > Q3 + 1.5 * IQR)]
            
            msg = "📊 **数据分析结果**\n"
            msg += "━━━━━━━━━━━━━━━\n"
            for key, value in stats.items():
                msg += f"▪ {key}: {value}\n"
            
            if not outliers.empty:
                msg += f"\n⚠️ 检测到{len(outliers)}个异常值:\n"
                msg += f"{outliers['value'].tolist()}"
            
            # 缓存数据供图表使用
            self.data_cache[e.get('user_id')] = arr
            
            return {"reply": msg}
            
        except ValueError as e:
            return {"reply": f"数据解析错误: {str(e)}"}
        except Exception as e:
            return {"reply": f"分析失败: {str(e)}"}
    
    async def create_chart(self, *args):
        """创建数据图表"""
        if not HAS_IMAGE_LIBS or not HAS_DATA_LIBS:
            return {"reply": "需要安装matplotlib和numpy库才能创建图表"}
        
        e = self.e
        msg = e.get('msg', '')
        user_id = e.get('user_id')
        
        # 提取参数
        match = re.search(r'py图表\s+(.+)$', msg)
        chart_type = match.group(1).strip() if match else 'line'
        
        # 检查缓存数据
        if user_id not in self.data_cache:
            return {"reply": "请先使用 #py分析 命令分析数据"}
        
        data = self.data_cache[user_id]
        
        try:
            # 创建图表
            fig, ax = plt.subplots(figsize=(10, 6))
            
            if chart_type == 'hist' or chart_type == '直方图':
                ax.hist(data, bins=20, color='skyblue', edgecolor='black', alpha=0.7)
                ax.set_xlabel('值')
                ax.set_ylabel('频数')
                ax.set_title('数据分布直方图')
            elif chart_type == 'box' or chart_type == '箱线图':
                ax.boxplot(data, vert=True, patch_artist=True)
                ax.set_ylabel('值')
                ax.set_title('箱线图分析')
            elif chart_type == 'density' or chart_type == '密度':
                from scipy import stats
                density = stats.gaussian_kde(data)
                x = np.linspace(data.min(), data.max(), 200)
                ax.plot(x, density(x), color='blue', linewidth=2)
                ax.fill_between(x, density(x), alpha=0.3, color='skyblue')
                ax.set_xlabel('值')
                ax.set_ylabel('密度')
                ax.set_title('概率密度分布')
            else:  # 默认折线图
                ax.plot(range(len(data)), data, marker='o', linewidth=2, markersize=4)
                ax.set_xlabel('索引')
                ax.set_ylabel('值')
                ax.set_title('数据趋势图')
                ax.grid(True, alpha=0.3)
            
            # 保存为图片
            import io
            buf = io.BytesIO()
            plt.tight_layout()
            plt.savefig(buf, format='png', dpi=100, bbox_inches='tight')
            plt.close()
            
            # 转为base64
            buf.seek(0)
            img_base64 = base64.b64encode(buf.read()).decode()
            
            return {
                "reply": [
                    f"📈 生成了{chart_type}图表：",
                    {
                        "type": "image",
                        "file": f"base64://{img_base64}"
                    }
                ]
            }
            
        except Exception as e:
            return {"reply": f"创建图表失败: {str(e)}"}
    
    async def predict(self, *args):
        """机器学习预测"""
        if not HAS_ML_LIBS or not HAS_DATA_LIBS:
            return {"reply": "需要安装scikit-learn库才能使用预测功能"}
        
        e = self.e
        msg = e.get('msg', '')
        
        # 提取参数
        match = re.search(r'py预测\s+(.+)$', msg)
        if not match:
            return {"reply": "请提供历史数据（用逗号分隔）"}
        
        data_str = match.group(1).strip()
        
        try:
            # 解析数据
            data = [float(x.strip()) for x in data_str.split(',')]
            
            if len(data) < 3:
                return {"reply": "需要至少3个数据点才能进行预测"}
            
            # 准备训练数据
            X = np.array(range(len(data))).reshape(-1, 1)
            y = np.array(data)
            
            # 标准化
            scaler_X = StandardScaler()
            scaler_y = StandardScaler()
            X_scaled = scaler_X.fit_transform(X)
            y_scaled = scaler_y.fit_transform(y.reshape(-1, 1)).ravel()
            
            # 训练模型
            model = LinearRegression()
            model.fit(X_scaled, y_scaled)
            
            # 预测未来5个点
            future_points = 5
            future_X = np.array(range(len(data), len(data) + future_points)).reshape(-1, 1)
            future_X_scaled = scaler_X.transform(future_X)
            predictions_scaled = model.predict(future_X_scaled)
            predictions = scaler_y.inverse_transform(predictions_scaled.reshape(-1, 1)).ravel()
            
            # 计算模型评分
            score = model.score(X_scaled, y_scaled)
            
            # 计算趋势
            slope = model.coef_[0]
            trend = "上升" if slope > 0.1 else "下降" if slope < -0.1 else "平稳"
            
            msg = "🤖 **机器学习预测结果**\n"
            msg += "━━━━━━━━━━━━━━━\n"
            msg += f"📈 趋势: {trend}\n"
            msg += f"📊 模型准确度: {score*100:.2f}%\n"
            msg += f"\n未来{future_points}个预测值:\n"
            
            for i, pred in enumerate(predictions, 1):
                msg += f"  {i}. {pred:.2f}\n"
            
            msg += f"\n💡 提示: 基于线性回归模型"
            
            return {"reply": msg}
            
        except Exception as e:
            return {"reply": f"预测失败: {str(e)}"}


class WebScraperPlugin(PythonPlugin):
    """网络爬虫插件 - 展示Python的网络数据获取能力"""
    
    def __init__(self):
        super().__init__()
        self.name = "Python爬虫"
        self.priority = 45
        
        self.rule = [
            PluginRule(
                reg=r"^#?py爬取\s+(.+)$",
                fnc="scrape_web",
                event="message"
            ),
            PluginRule(
                reg=r"^#?py热搜$",
                fnc="get_trending",
                event="message"
            )
        ]
    
    async def scrape_web(self, *args):
        """网页爬取"""
        if not HAS_WEB_LIBS:
            return {"reply": "需要安装aiohttp和beautifulsoup4库才能使用爬虫功能"}
        
        e = self.e
        msg = e.get('msg', '')
        
        match = re.search(r'py爬取\s+(.+)$', msg)
        if not match:
            return {"reply": "请提供要爬取的URL"}
        
        url = match.group(1).strip()
        
        # 验证URL
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=10) as response:
                    if response.status != 200:
                        return {"reply": f"获取网页失败: HTTP {response.status}"}
                    
                    html = await response.text()
                    soup = BeautifulSoup(html, 'html.parser')
                    
                    # 提取信息
                    title = soup.title.string if soup.title else "无标题"
                    
                    # 提取meta描述
                    description = ""
                    meta_desc = soup.find('meta', attrs={'name': 'description'})
                    if meta_desc:
                        description = meta_desc.get('content', '')
                    
                    # 统计链接
                    links = soup.find_all('a')
                    images = soup.find_all('img')
                    
                    # 提取前5个标题
                    headings = []
                    for tag in ['h1', 'h2', 'h3']:
                        for heading in soup.find_all(tag)[:2]:
                            text = heading.get_text(strip=True)
                            if text:
                                headings.append(f"[{tag.upper()}] {text}")
                    
                    msg = f"🕸️ **网页信息**\n"
                    msg += f"━━━━━━━━━━━━━━━\n"
                    msg += f"📌 标题: {title}\n"
                    if description:
                        msg += f"📝 描述: {description[:100]}...\n"
                    msg += f"🔗 链接数: {len(links)}\n"
                    msg += f"🖼️ 图片数: {len(images)}\n"
                    
                    if headings:
                        msg += f"\n📑 主要标题:\n"
                        for h in headings[:5]:
                            msg += f"  • {h}\n"
                    
                    return {"reply": msg}
                    
        except asyncio.TimeoutError:
            return {"reply": "爬取超时，请稍后重试"}
        except Exception as e:
            return {"reply": f"爬取失败: {str(e)}"}
    
    async def get_trending(self, *args):
        """获取热搜（模拟）"""
        if not HAS_WEB_LIBS:
            return {"reply": "需要安装网络库才能获取热搜"}
        
        # 这里应该爬取真实的热搜，但为了示例简化
        import random
        
        topics = [
            "Python 3.12发布新特性",
            "AI绘画技术突破",
            "量子计算新进展",
            "元宇宙应用落地",
            "新能源汽车销量创新高",
            "ChatGPT更新重大功能",
            "区块链技术新应用",
            "云计算市场竞争加剧",
            "5G网络覆盖率提升",
            "机器学习框架更新"
        ]
        
        # 随机选择并排序
        selected = random.sample(topics, min(5, len(topics)))
        
        msg = "🔥 **今日热搜**\n"
        msg += "━━━━━━━━━━━━━━━\n"
        
        for i, topic in enumerate(selected, 1):
            heat = random.randint(100000, 9999999)
            msg += f"{i}. {topic} 🔥{heat}\n"
        
        msg += f"\n更新时间: {datetime.now().strftime('%H:%M:%S')}"
        
        return {"reply": msg}


class NLPPlugin(PythonPlugin):
    """自然语言处理插件"""
    
    def __init__(self):
        super().__init__()
        self.name = "Python NLP"
        self.priority = 42
        
        self.rule = [
            PluginRule(
                reg=r"^#?py分词\s+(.+)$",
                fnc="segment_text",
                event="message"
            ),
            PluginRule(
                reg=r"^#?py词云\s+(.+)$",
                fnc="word_cloud",
                event="message"
            ),
            PluginRule(
                reg=r"^#?py情感\s+(.+)$",
                fnc="sentiment_analysis",
                event="message"
            )
        ]
    
    async def segment_text(self, *args):
        """中文分词"""
        if not HAS_NLP_LIBS:
            return {"reply": "需要安装jieba库才能使用分词功能"}
        
        e = self.e
        msg = e.get('msg', '')
        
        match = re.search(r'py分词\s+(.+)$', msg)
        if not match:
            return {"reply": "请提供要分词的文本"}
        
        text = match.group(1).strip()
        
        # 执行分词
        words = jieba.lcut(text)
        
        # 词频统计
        from collections import Counter
        word_freq = Counter(words)
        
        # 提取关键词
        import jieba.analyse
        keywords = jieba.analyse.extract_tags(text, topK=5, withWeight=True)
        
        msg = "✂️ **分词结果**\n"
        msg += "━━━━━━━━━━━━━━━\n"
        msg += f"分词: {' / '.join(words)}\n\n"
        
        msg += "📊 词频TOP5:\n"
        for word, freq in word_freq.most_common(5):
            msg += f"  • {word}: {freq}次\n"
        
        msg += "\n🔑 关键词:\n"
        for word, weight in keywords:
            msg += f"  • {word}: {weight:.2f}\n"
        
        return {"reply": msg}
    
    async def word_cloud(self, *args):
        """生成词云"""
        if not HAS_NLP_LIBS or not HAS_IMAGE_LIBS:
            return {"reply": "需要安装jieba和wordcloud库才能生成词云"}
        
        e = self.e
        msg = e.get('msg', '')
        
        match = re.search(r'py词云\s+(.+)$', msg)
        if not match:
            return {"reply": "请提供文本内容"}
        
        text = match.group(1).strip()
        
        try:
            # 分词
            words = ' '.join(jieba.cut(text))
            
            # 生成词云
            wc = wordcloud.WordCloud(
                width=800,
                height=400,
                background_color='white',
                font_path='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',  # 需要根据系统调整
                max_words=50
            ).generate(words)
            
            # 保存为图片
            import io
            from PIL import Image
            
            img = wc.to_image()
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            
            # 转为base64
            buf.seek(0)
            img_base64 = base64.b64encode(buf.read()).decode()
            
            return {
                "reply": [
                    "☁️ 生成了词云图：",
                    {
                        "type": "image",
                        "file": f"base64://{img_base64}"
                    }
                ]
            }
            
        except Exception as e:
            return {"reply": f"生成词云失败: {str(e)}"}
    
    async def sentiment_analysis(self, *args):
        """情感分析（简化版）"""
        e = self.e
        msg = e.get('msg', '')
        
        match = re.search(r'py情感\s+(.+)$', msg)
        if not match:
            return {"reply": "请提供要分析的文本"}
        
        text = match.group(1).strip()
        
        # 简单的情感词典
        positive_words = ['好', '棒', '优秀', '喜欢', '开心', '快乐', '幸福', '美好', '赞', '爱']
        negative_words = ['差', '坏', '糟糕', '讨厌', '难过', '伤心', '失望', '烦', '恨', '怕']
        
        # 计算情感分数
        pos_score = sum(1 for word in positive_words if word in text)
        neg_score = sum(1 for word in negative_words if word in text)
        
        total = pos_score + neg_score
        if total == 0:
            sentiment = "中性"
            score = 0
        else:
            score = (pos_score - neg_score) / total
            if score > 0.3:
                sentiment = "积极 😊"
            elif score < -0.3:
                sentiment = "消极 😔"
            else:
                sentiment = "中性 😐"
        
        msg = "💭 **情感分析结果**\n"
        msg += "━━━━━━━━━━━━━━━\n"
        msg += f"文本: {text[:50]}...\n" if len(text) > 50 else f"文本: {text}\n"
        msg += f"情感倾向: {sentiment}\n"
        msg += f"积极词数: {pos_score}\n"
        msg += f"消极词数: {neg_score}\n"
        msg += f"情感得分: {score:.2f}\n"
        
        return {"reply": msg}


# 导出所有插件
__all__ = ['DataAnalysisPlugin', 'WebScraperPlugin', 'NLPPlugin']