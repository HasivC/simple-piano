# PIANO

手机上的发光琴键：3×5 / 3×7 **矩形键矩阵**、14 种音色、多页扩展音域、
多指和弦、滑指刮奏、录音回放。竖屏横屏都支持，纯 Web 技术实现（Web Audio API），零依赖。

| 形态 | 文件 | 适用 |
| --- | --- | --- |
| **安卓 App** | `dist/PIANO-1.0.apk`（构建产物） | 安卓手机，全屏、可离线、无联网权限 |
| **PWA / 网页** | `index.html` 整个目录 | 安卓 + **iOS**，可「添加到主屏幕」，离线可用 |
| **单文件** | `piano-standalone.html`（构建产物） | 一个文件发给任何人，浏览器打开即弹 |

```
piano/
├─ index.html / styles.css / audio.js / app.js     ← 网页本体
├─ manifest.webmanifest / sw.js / icons/           ← PWA 与图标（PNG，程序化生成）
├─ android/                    ← 安卓工程源码（Manifest + MainActivity + 资源）
├─ tools/
│   ├─ make-icons.mjs          程序化生成全部图标（自带 PNG 编码器 + 圆角矩形光栅化）
│   ├─ fetch-sdk.ps1           下载最小 Android SDK（仅构建 APK 时需要联网）
│   ├─ build-apk.ps1           不用 Gradle，直接用 aapt2/javac/d8/apksigner 打包
│   ├─ inspect-apk.mjs         APK 结构体检（对齐、压缩方式、资源路径）
│   ├─ smoke-test.mjs          14 种音色逐一出音 + 配置交叉校验
│   └─ dom-sim.mjs             极简 DOM 仿真，端到端跑一遍演奏与横竖屏布局
├─ serve.mjs                   局域网静态服务器
└─ build-standalone.mjs        重新生成单文件版
```

## 界面

**矩形键块**：每行 5 键（或 7 键）、共 3 行，三行完全对齐 —— 这是唯一的布局改动：
原来的半格错位会让整块看起来像个平行四边形。

键本身的形状、圆角、尺寸算法都保持原样（正方形的圆角键；尺寸取「宽度装得下」和
「高度装得下」的较小值）。因为不再需要为错位预留那半格宽度，键会比之前略大一点：
竖屏键位区 390×520 下从 57.6 px 变成 68 px。按下的键会点亮、向外扩散光环并轻微振动。

## 安卓 APK

**安装**：把 `dist/PIANO-1.0.apk` 传到手机（微信/QQ/数据线都行），点开安装，
系统提示「未知来源」时允许即可。装好后桌面图标是「PIANO」。

- 包名 `com.piano.app`，versionCode 1，最低 Android 5.0（API 23），目标 API 34
- **权限只有「振动」一个，完全没有联网权限**，页面全部来自安装包内的 assets
- 全屏沉浸式（隐藏状态栏/导航栏）、常亮不息屏、自适应图标
- **横竖屏都支持**：`screenOrientation="user"`，跟随系统自动旋转开关；
  旋转时 Activity 不重建（`configChanges` 含 `orientation|screenSize`），
  所以**转屏不会打断正在弹的音或录音**
- 返回键：先关设置面板 / 停回放，都没得关才退出 App
- 音色、键位、录音存在手机本地（WebView 的 localStorage）

**重新构建**（改了网页代码后想出新 APK）：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
tools\fetch-sdk.ps1     # 只需第一次：下载 build-tools + platform 到 .android-sdk（约 120MB）
tools\build-apk.ps1     # 之后每次都离线构建，末尾会自动做结构体检
```

不依赖 Gradle / Android Studio，只用 JDK 21 + aapt2 + d8 + zipalign + apksigner。
签名用 `keystore/piano.keystore`（首次构建自动生成，口令都是 `android`）——
自己装着玩没问题；要上架应用商店请换成你自己的签名并保管好密钥。

## 横屏与竖屏

| | 竖屏（键位区约 390×520） | 横屏（键位区约 844×330） |
| --- | --- | --- |
| 3×5 单键 | 68 × 68 px | 97.6 × 97.6 px |
| 顶部 / 底部栏 | 常规 | 自动压扁，少占高度 |
| 设置面板 | 底部抽屉 | **右侧栏**（横屏时底部抽屉会把琴键挤没） |
| 提示条 | 显示 | 自动隐藏 |
| 3×7 布局 | 放得下 | 放得下 |

键尺寸仍由**可用空间**决定（竖屏受宽度限制、横屏受高度限制），这是原有的尺寸算法，
这次没有改动；只改了「三行对齐」。所以横屏时键会大一些——如果你要的是两个方向
**尺寸完全一致**，需要另外指定一个尺寸基准（例如按屏幕短边算），那是一处独立改动。
刘海屏横屏的左右安全区、iOS 的动态视口高度（`dvh`）都已处理。

## iOS 能用吗

**能，但装不了这个 APK**（APK 是安卓格式）。iOS 用网页版，体验接近原生 App：

1. 把整个目录放到任意 https 静态托管（GitHub Pages / Vercel / Netlify 都行），
   或者用 `node serve.mjs` 在电脑上开局域网（手机连同一 Wi-Fi）。
2. iPhone 用 **Safari** 打开该地址 → 分享按钮 → **添加到主屏幕**。
3. 桌面图标就是那排光键（PNG 图标专门生成过，iOS 只认 PNG），点开是全屏、
   无地址栏、可离线（service worker 已缓存全部资源），横竖屏都能转。

已经为 iOS 做过：`apple-mobile-web-app-capable` 全屏、`viewport-fit=cover` 适配刘海、
`-webkit-touch-callout` 禁止长按弹菜单、首次触摸解锁 Web Audio、
`100dvh` 规避 iOS 横屏工具栏高度抖动。服务端不需要任何特殊配置。

> iOS 的**静音拨片**会让网页音频静音——没声音先检查拨片和音量键。
>
> 想要真正上架 App Store 的 `.ipa`：必须用 **Mac + Xcode** 打包（Windows 上做不到），
> 还需要 Apple 开发者账号。路径是 `npm i @capacitor/core @capacitor/cli @capacitor/ios`
> → `npx cap add ios` → `npx cap sync` → `npx cap open ios` 后签名。

## 怎么弹

| 操作 | 效果 |
| --- | --- |
| 轻触琴键 | 发声，光键点亮并扩散光环，带轻微振动 |
| 多指同时按 | 直接弹和弦 |
| 手指滑过琴键 | 刮奏；滑出琴键自动收音 |
| 底部「延音」 | 松开手指后声音继续，像踩住踏板 |
| 左右滑动 / ‹ › / 页点 | 翻页 |
| 顶部音色标签 | 换音色（点击即试听） |
| 顶部 ⚙ | 音阶、布局、音量、混响、录音 |
| 顶部 ● / ▶ | 录音 / 回放（支持循环） |

电脑键盘：`Z X C V B N M`（下排）· `A S D F G H J`（中排）· `Q W E R T Y U`（上排），
翻页 `← →` 或 `, .`

## 键位与音域设计

- **3 行 × 5 列**（15 键）或 **3 行 × 7 列**（21 键），从左到右、从下到上音高递增。
- 翻页时整体**升高一个八度**，所以每页形状一致、都从主音开始，相邻页自然重叠，
  不会出现某一页全是听不见的高音。
- 音阶：自然大调 / 自然小调 / 五声音阶 / 半音阶；起始八度 C1–C5。
- 例：3×5 + 自然大调，1 页 = C3–C5；3 页 = C3–C7；**4 页 = C1–C8（完整钢琴音域）**。

## 14 种音色

大钢琴 · 电钢琴 · 八音盒 · 竖琴 · 吉他 · 钟琴 · 长笛 · 弦乐 ·
管风琴 · 马林巴 · 合成铺底 · 口琴 · 电子 8bit · 人声「啊」

全部是 Web Audio 实时合成：`audio.js` 里每种音色就是一条参数记录
（谐波比例与各自衰减、ADSR、滤波包络、FM 调制、颤音/震音、共振峰、混响送出）。
想加音色照抄一条改数字即可。

## 开发自测

```bash
node tools/smoke-test.mjs            # 14 种音色逐一出音 + ID/选项/CSS 交叉校验
node tools/dom-sim.mjs               # 极简 DOM 仿真：触键/和弦/刮奏/翻页/录音 + 横竖屏布局
node tools/make-icons.mjs            # 重新生成全部图标
node tools/inspect-apk.mjs dist/PIANO-1.0.apk   # APK 结构体检
node build-standalone.mjs            # 重新生成单文件版
```

## 已知边界

- 音色是实时合成的电子感琴声，不是采样音源，音头比真钢琴略薄。
- **APK 只做了结构级验证**（签名、资源表、dex、zip 路径、对齐方式都逐项查过），
  构建机上没有安卓设备/模拟器，**没有在真机上安装运行过**。首次安装如有问题，
  连电脑用 `chrome://inspect` 能看到页面控制台（已开启 WebView 调试）。
- 布局数值由 DOM 仿真断言覆盖（竖屏 390×520、横屏 844×330 两种视口），
  但没有做像素级截图核对。
- 低端手机同时按很多键可能掉帧，可在设置里调低混响。
- `.android-sdk/`（约 350MB）和 `.build/` 是构建产物，可以删；删了下次构建会重新下载/生成。
