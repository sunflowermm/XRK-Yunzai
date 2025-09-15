# XRK-Yunzai v3.0.5

基于乐神版[云崽v3.0](https://gitee.com/le-niao/Yunzai-Bot) 与喵喵版[喵崽v3.1.3](https://gitee.com/yoimiya-kokomi/Miao-Yunzai) 还有时雨版[时雨崽3.1.3](https://gitee.com/TimeRainStarSky/Yunzai)

感谢我在编写过程中时雨佬等佬的帮助
感谢我在编写时萌新们的支持

## 使用方法

> 必要环境 Windows/Linux + Chrome/Chromium/Edge

> 必要环境 Node.js>18.14.0 + Redis>5.0.0

## XRK-Yunzai 后续计划

- 最快实现的就是pm2的启动方式（目前还没有实现，在查资料）{已经实现}
- 开源对接任务处理器（对接Mysql，微信公众号等）
- 投入农业实践使用
- 将icqq等相关底层剥离，以方便类型扩展和开发
- 完善任务处理逻辑，类型变量等等定义更加规范化

### 克隆项目

```sh
# 使用Gitcode
git clone --depth=1 https://gitcode.com/Xrkseek/XRK-Yunzai.git
cd XRK-Yunzai 
```

###  安装依赖<自动>

> 外网环境请修改的本地npm配置.npmrc,改完了之后再启动
> 国内环境直接运行即可
> 如果有没有安装上的依赖，可以下载向日葵插件发送#打依赖来安装

###  运行与指令相关（无需打依赖）

> 首次运行按提示输入登录
> 支持多开窗口登录，模仿类QQ平台类的处理方法，Bot多例运行，处理回复保持最大兼容性
> 与 Yunzai-Bot V3.0不同的是，icqq登录的配置文件储存在 data/bots/<QQ号> 文件夹内，
> 服务器登录相关插件在config/server_config内，方便了用户的迁移

启动启动脚本(这句话是不是很绕？嘻嘻嘻)
```sh
node app # 启动
```

###  葵崽到底改了哪里，相比于其他崽有哪些妥协和升级？

- 启动逻辑大改，让icqq带着账号登录，以方便多开，也优化了pm2相关
- 使用单例多开的方式，提高了日志的可读性和多开的可运营性(商用)
- stdin用户接入http，云崽也成为了拥有post的方法的api，真正意义上成为了机器人和消息处理器，而并非qq机器人或者多端机器人，可投入工农商三用，成为真正意义上的后端语言
- 无论是对象抑或是属性和变量的定义将在葵崽更好的呈现，不会不清晰
- 任务处理器更加多元化，函数更加通用(以方便后续对多类型文件或事件的处理)
- 引入了时雨崽的底层并进行了部分修改，支持双崽的所有函数和插件并进行了兼容处理
- 在很多细节处理上优化了用户体验，诸如icqq登录，chromium实例占用检查，全局的实例数量控制，以及一些函数的规范化
- 增加了喵崽没有的守护进程，得灵感于时雨崽，区分了服务器模式和icqq模式下的监听事件s
- loader部分做了很多的修改优化，以提高兼容性防止报错

### 葵崽重要特性

[点进来吧](./stdin.md)

<hr>

## 致谢

|                           Nickname                            |       name       |   Contribution   |
|:-------------------------------------------------------------:|------------------|------------------|
|      [Yunzai v3.0](https://gitee.com/le-niao/Yunzai-Bot)      | 乐神的Yunzai-Bot V3 | 元老级项目 |
|      [Miao-Yunzai v3.1.3](https://gitee.com/yoimiya-kokomi/Miao-Yunzai)      | 喵喵的Miao-Yunzai | 项目基础，提供了优化方向和原神功能适配 |
|      [TRSS-Yunzai v3.1.3](https://gitee.com/TimeRainStarSky/Yunzai)      | 时雨的Yunzai | 为葵崽底层设计提供了不可磨灭的贡献，时雨崽是当之无愧的node项目的艺术品 |