import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import type { AlexaStatus, EchoSkillStatus, OverlayMessage, PhoneBridgeStatus, SnapPhoto, QuickUpdate, BackendConnection, BackendStatus, OrbState, VyrseBridge } from '../shared/backend-types'

// Sandboxed preloads cannot require local modules, so channel names are inlined
// here; they must match IPC_CHANNELS in shared/backend-types.ts.
const CH = {
  getConnection: 'vyrse:backend:get-connection',
  getStatus: 'vyrse:backend:get-status',
  restart: 'vyrse:backend:restart',
  status: 'vyrse:backend:status',
  presence: 'vyrse:presence',
  orbState: 'vyrse:orb-state',
  showMain: 'vyrse:show-main',
  orbInteractive: 'vyrse:orb-interactive',
  setTalkShortcut: 'vyrse:set-talk-shortcut',
  talkShortcut: 'vyrse:talk-shortcut',
  setDictateShortcut: 'vyrse:set-dictate-shortcut',
  dictateShortcut: 'vyrse:dictate-shortcut',
  typeText: 'vyrse:type-text',
  alexa: 'vyrse:alexa',
  alexaStatus: 'vyrse:alexa-status',
  echoSkill: 'vyrse:echo-skill',
  echoSkillStatus: 'vyrse:echo-skill-status',
  echoAsk: 'vyrse:echo-ask',
  echoAnswer: 'vyrse:echo-answer',
  copyText: 'vyrse:copy-text',
  setQuickShortcut: 'vyrse:set-quick-shortcut',
  quickAsk: 'vyrse:quick-ask',
  quickForward: 'vyrse:quick-forward',
  quickAnswer: 'vyrse:quick-answer',
  quickUpdate: 'vyrse:quick-update',
  quickResize: 'vyrse:quick-resize',
  quickShow: 'vyrse:quick-show',
  quickHide: 'vyrse:quick-hide',
  quickHideRequest: 'vyrse:quick-hide-request',
  quickOpenMain: 'vyrse:quick-open-main',
  phone: 'vyrse:phone',
  phoneStatus: 'vyrse:phone-status',
  overlay: 'vyrse:overlay',
  overlayShow: 'vyrse:overlay-show',
  overlayIdle: 'vyrse:overlay-idle',
  overlayStop: 'vyrse:overlay-stop',
  overlayClicked: 'vyrse:overlay-clicked',
  snap: 'vyrse:snap',
} as const

const bridge: VyrseBridge = {
  backend: {
    getConnection: () => ipcRenderer.invoke(CH.getConnection) as Promise<BackendConnection | null>,
    getStatus: () => ipcRenderer.invoke(CH.getStatus) as Promise<BackendStatus>,
    restart: () => ipcRenderer.invoke(CH.restart) as Promise<void>,
    onStatus(callback) {
      const listener = (_event: IpcRendererEvent, status: BackendStatus) => callback(status)
      ipcRenderer.on(CH.status, listener)
      return () => ipcRenderer.removeListener(CH.status, listener)
    },
  },
  desktop: {
    pathForFile: file => webUtils.getPathForFile(file),
    presence: state => ipcRenderer.send(CH.presence, state),
    onOrbState(callback) {
      const listener = (_event: IpcRendererEvent, state: OrbState) => callback(state)
      ipcRenderer.on(CH.orbState, listener)
      return () => ipcRenderer.removeListener(CH.orbState, listener)
    },
    showMain: () => ipcRenderer.send(CH.showMain),
    setInteractive: interactive => ipcRenderer.send(CH.orbInteractive, interactive),
    setTalkShortcut: accelerator => ipcRenderer.invoke(CH.setTalkShortcut, accelerator) as Promise<boolean>,
    onTalkShortcut(callback) {
      const listener = () => callback()
      ipcRenderer.on(CH.talkShortcut, listener)
      return () => ipcRenderer.removeListener(CH.talkShortcut, listener)
    },
    setDictateShortcut: accelerator => ipcRenderer.invoke(CH.setDictateShortcut, accelerator) as Promise<boolean>,
    onDictateShortcut(callback) {
      const listener = () => callback()
      ipcRenderer.on(CH.dictateShortcut, listener)
      return () => ipcRenderer.removeListener(CH.dictateShortcut, listener)
    },
    typeText: text => ipcRenderer.invoke(CH.typeText, text) as Promise<boolean>,
    alexa: (op, args) => ipcRenderer.invoke(CH.alexa, op, args) as Promise<unknown>,
    onAlexaStatus(callback) {
      const listener = (_event: IpcRendererEvent, status: AlexaStatus) => callback(status)
      ipcRenderer.on(CH.alexaStatus, listener)
      return () => ipcRenderer.removeListener(CH.alexaStatus, listener)
    },
    echoSkill: (op, args) => ipcRenderer.invoke(CH.echoSkill, op, args) as Promise<unknown>,
    onEchoSkillStatus(callback) {
      const listener = (_event: IpcRendererEvent, status: EchoSkillStatus) => callback(status)
      ipcRenderer.on(CH.echoSkillStatus, listener)
      return () => ipcRenderer.removeListener(CH.echoSkillStatus, listener)
    },
    onEchoAsk(callback) {
      const listener = (_event: IpcRendererEvent, ask: { id: string; text: string }) => callback(ask)
      ipcRenderer.on(CH.echoAsk, listener)
      return () => ipcRenderer.removeListener(CH.echoAsk, listener)
    },
    echoAnswer: (id, text) => ipcRenderer.send(CH.echoAnswer, { id, text }),
    copyText: text => ipcRenderer.invoke(CH.copyText, text) as Promise<boolean>,
    setQuickShortcut: accelerator => ipcRenderer.invoke(CH.setQuickShortcut, accelerator) as Promise<boolean>,
    onQuickAsk(callback) {
      const listener = (_event: IpcRendererEvent, ask: { id: string; text: string }) => callback(ask)
      ipcRenderer.on(CH.quickForward, listener)
      return () => ipcRenderer.removeListener(CH.quickForward, listener)
    },
    quickAnswer: update => ipcRenderer.send(CH.quickAnswer, update),
    phone: (op, args) => ipcRenderer.invoke(CH.phone, op, args) as Promise<unknown>,
    onPhoneStatus(callback) {
      const listener = (_event: IpcRendererEvent, status: PhoneBridgeStatus) => callback(status)
      ipcRenderer.on(CH.phoneStatus, listener)
      return () => ipcRenderer.removeListener(CH.phoneStatus, listener)
    },
    overlay: message => ipcRenderer.send(CH.overlay, message),
    onOverlayStop(callback) {
      const listener = () => callback()
      ipcRenderer.on(CH.overlayStop, listener)
      return () => ipcRenderer.removeListener(CH.overlayStop, listener)
    },
    onOverlayClicked(callback) {
      const listener = () => callback()
      ipcRenderer.on(CH.overlayClicked, listener)
      return () => ipcRenderer.removeListener(CH.overlayClicked, listener)
    },
    onSnap(callback) {
      const listener = (_event: IpcRendererEvent, photo: SnapPhoto) => callback(photo)
      ipcRenderer.on(CH.snap, listener)
      return () => ipcRenderer.removeListener(CH.snap, listener)
    },
  },
  overlayPage: {
    onShow(callback) {
      const listener = (_event: IpcRendererEvent, message: OverlayMessage) => callback(message)
      ipcRenderer.on(CH.overlayShow, listener)
      return () => ipcRenderer.removeListener(CH.overlayShow, listener)
    },
    idle: () => ipcRenderer.send(CH.overlayIdle),
  },
  quick: {
    ask: (id, text) => ipcRenderer.send(CH.quickAsk, { id, text }),
    onUpdate(callback) {
      const listener = (_event: IpcRendererEvent, update: QuickUpdate) => callback(update)
      ipcRenderer.on(CH.quickUpdate, listener)
      return () => ipcRenderer.removeListener(CH.quickUpdate, listener)
    },
    onShow(callback) {
      const listener = () => callback()
      ipcRenderer.on(CH.quickShow, listener)
      return () => ipcRenderer.removeListener(CH.quickShow, listener)
    },
    onHide(callback) {
      const listener = () => callback()
      ipcRenderer.on(CH.quickHide, listener)
      return () => ipcRenderer.removeListener(CH.quickHide, listener)
    },
    resize: height => ipcRenderer.send(CH.quickResize, height),
    hide: () => ipcRenderer.send(CH.quickHideRequest),
    openMain: () => ipcRenderer.send(CH.quickOpenMain),
  },
}

contextBridge.exposeInMainWorld('vyrse', bridge)
