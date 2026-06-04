/**
 * plugin 的 runtime，可通过 e.runtime 访问
 *
 * 提供一些常用的运行时变量、方法及 model 获取
 * 降低对目录结构的依赖（对齐 TRSS-Yunzai）
 */
import lodash from "lodash"
import fs from "node:fs/promises"
import common from "../common/common.js"
import cfg from "../config/config.js"
import Renderer from "../renderer/loader.js"
import Handler from "./handler.js"

const puppeteer = Renderer.getRenderer()

let gsCfg, MysApi, MysInfo, NoteUser, MysUser, Version
try {
  gsCfg = (await import("../../plugins/genshin/model/gsCfg.js")).default
  MysApi = (await import("../../plugins/genshin/model/mys/mysApi.js")).default
  MysInfo = (await import("../../plugins/genshin/model/mys/mysInfo.js")).default
  NoteUser = (await import("../../plugins/genshin/model/mys/NoteUser.js")).default
  MysUser = (await import("../../plugins/genshin/model/mys/MysUser.js")).default
} catch {}
try {
  Version = (await import("#miao")).Version
} catch {}

function applyMysGame(option = {}, e, isSr = false) {
  if (option.game) return option
  if (isSr || e?.isSr || e?.game === "sr") option.game = "sr"
  else if (e?.isZzz || e?.game === "zzz") option.game = "zzz"
  return option
}

export default class Runtime {
  constructor(e) {
    this.e = e
    this._mysInfo = {}
    this.handler = {
      has: Handler.has,
      call: Handler.call,
      callAll: Handler.callAll,
    }
  }

  get uid() {
    return this.user?.uid
  }

  get hasCk() {
    return this.user?.hasCk
  }

  get user() {
    return this.e.user
  }

  get cfg() {
    return cfg
  }

  get gsCfg() {
    return gsCfg
  }

  get common() {
    return common
  }

  get puppeteer() {
    return puppeteer
  }

  getRenderer(name = null) {
    return Renderer.getRenderer(name)
  }

  get MysInfo() {
    return MysInfo
  }

  get NoteUser() {
    return NoteUser
  }

  get MysUser() {
    return MysUser
  }

  async initUser() {
    let e = this.e
    let user = await NoteUser.create(e)
    if (user) {
      e.user = new Proxy(user, {
        get(self, key, receiver) {
          let game = e.game
          let fnMap = {
            uid: "getUid",
            uidList: "getUidList",
            mysUser: "getMysUser",
            ckUidList: "getCkUidList",
          }
          if (fnMap[key]) {
            return self[fnMap[key]](game)
          }
          if (key === "uidData") {
            return self.getUidData("", game)
          }
          if (
            [
              "getUid",
              "getUidList",
              "getMysUser",
              "getCkUidList",
              "getUidMapList",
              "getGameDs",
            ].includes(key)
          ) {
            return (_game, arg2) => {
              return self[key](_game || game, arg2)
            }
          }
          if (["getUidData", "hasUid", "addRegUid", "delRegUid", "setMainUid"].includes(key)) {
            return (uid, _game = "") => {
              return self[key](uid, _game || game)
            }
          }
          return self[key]
        },
      })
    }
  }

  async getMysInfo(targetType = "all") {
    if (!this._mysInfo[targetType]) {
      this._mysInfo[targetType] = await MysInfo.init(
        this.e,
        targetType === "cookie" ? "detail" : "roleIndex",
      )
    }
    return this._mysInfo[targetType]
  }

  async getUid() {
    return await MysInfo.getUid(this.e)
  }

  async getMysApi(targetType = "all", option = {}, isSr = false) {
    let mys = await this.getMysInfo(targetType)
    if (mys.uid && mys?.ckInfo?.ck) {
      applyMysGame(option, this.e, isSr)
      return new MysApi(mys.uid, mys.ckInfo.ck, option)
    }
    return false
  }

  createMysApi(uid, ck, option, isSr = false) {
    applyMysGame(option, this.e, isSr)
    return new MysApi(uid, ck, option)
  }

  async render(plugin, path, data = {}, cfg = {}) {
    path = path.replace(/.html$/, "")
    let paths = lodash.filter(path.split("/"), p => !!p)
    path = paths.join("/")
    await Bot.mkdir(`temp/html/${plugin}/${path}`)
    let pluResPath = `../../../${lodash.repeat("../", paths.length)}plugins/${plugin}/resources/`
    let miaoResPath = `../../../${lodash.repeat("../", paths.length)}plugins/miao-plugin/resources/`
    const layoutPath = process.cwd() + "/plugins/miao-plugin/resources/common/layout/"
    data = {
      sys: {
        scale: 1,
      },
      copyright: `Created By TRSS-Yunzai ${Version?.yunzai} `,
      _res_path: pluResPath,
      _miao_path: miaoResPath,
      _tpl_path: process.cwd() + "/plugins/miao-plugin/resources/common/tpl/",
      defaultLayout: layoutPath + "default.html",
      elemLayout: layoutPath + "elem.html",
      ...data,
      _plugin: plugin,
      _htmlPath: path,
      pluResPath,
      tplFile: `./plugins/${plugin}/resources/${path}.html`,
      saveId: data.saveId || data.save_id || paths[paths.length - 1],
    }
    if (cfg.beforeRender) {
      data = cfg.beforeRender({ data }) || data
    }
    if (process.argv.includes("dev")) {
      const saveDir = `temp/ViewData/${plugin}`
      await Bot.mkdir(saveDir)
      const file = `${saveDir}/${data._htmlPath.split("/").join("_")}.json`
      await fs.writeFile(file, JSON.stringify(data))
    }
    let base64 = await puppeteer.screenshot(`${plugin}/${path}`, data)
    if (cfg.retType === "base64") {
      return base64
    }
    let ret = true
    if (base64) {
      if (cfg.recallMsg) {
        ret = await this.e.reply(base64, false, {})
      } else {
        ret = await this.e.reply(base64)
      }
    }
    return cfg.retType === "msgId" ? ret : true
  }

  static async init(e) {
    await MysInfo.initCache()
    e.runtime = new Runtime(e)
    await e.runtime.initUser()
    return e.runtime
  }
}

if (!MysInfo || !NoteUser) {
  Runtime.init = async e => (e.runtime = new Runtime(e))
}
