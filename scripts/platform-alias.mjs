// 平台标准名与别名：把 81 个写法里的碎片归并到标准名，同时保留原写法可搜。
//
// 为什么需要这份表：
//   平台归一（fetch-games.mjs 的 PLATFORM_MAP）只处理「能靠规则判断」的写法，
//   剩下的原样保留，于是出现大量同义碎片 —— アーケード / Arcade / AC / アーケードゲーム
//   是同一个平台，Nitendo Switch（拼错）/ Switch 是同一个，Play Station 2 / PS2 是同一个。
//   这些碎片在筛选下拉里各占一项，用户搜「街机」也搜不到「アーケード」。
//
// 结构：标准名 -> 该平台的所有可搜写法（含标准名本身、中英日、常见缩写、错拼）。
//   构建期由 build-alias-groups.mjs 展开成「任一写法 -> 同组全部写法」，
//   运行时注入每条记录的 pla 字段参与搜索，因此搜任一写法都能命中全集。
//
// 维护约定：
//   - key 必须是 PLATFORM_MAP 能产出的标准名（见 fetch-games.mjs），不要凭空造新名。
//   - 只收「确实是同一平台」的别名。Nitendo Switch 是拼写错误也收，因为上游数据就这么写。
//   - 不确定是否同一平台的（如 FX、NP、S、AC 这类缩写）宁可归到最接近的标准名，
//     也不要留在外面当独立项 —— 它们在筛选里毫无意义。
export const PLATFORM_ALIAS = {
  PC: ['PC', 'Windows', 'Win', 'PC-98', 'PC-88', 'PC-8801', 'PC-8001', 'DOS', 'FMTOWNS', 'FM TOWNS', 'MSX', 'XP pro', 'Silverlight', '电脑', '个人电脑'],
  Switch: ['Switch', 'Nitendo Switch', 'NS', 'Nintendo Switch', 'Switch Lite', 'スイッチ'],
  'Switch 2': ['Switch 2', 'Nintendo Switch 2', 'Switch2'],
  PS: ['PS', 'PlayStation', 'PS1', 'Play Station', 'プレイステーション'],
  PS2: ['PS2', 'Play Station 2', 'PlayStation 2', 'プレイステーション2'],
  PS3: ['PS3', 'PlayStation 3', 'プレイステーション3'],
  PS4: ['PS4', 'PlayStation 4', 'プレイステーション4'],
  PS5: ['PS5', 'PlayStation 5', 'プレイステーション5'],
  PSP: ['PSP', 'PlayStation Portable', 'プレイステーション・ポータブル'],
  PSV: ['PSV', 'PS Vita', 'PSVita', 'PlayStation Vita', 'ヴィータ'],
  PSVR: ['PSVR', 'PlayStation VR', 'HTC Vive PlayStationVR', 'プレイステーションVR'],
  'Xbox': ['Xbox', 'Xbox X', 'Microsoft Xbox'],
  'Xbox 360': ['Xbox 360', 'Xbox360', 'X360'],
  'Xbox One': ['Xbox One', 'XboxOne', 'XB1'],
  'Xbox Series X/S': ['Xbox Series X/S', 'Xbox Series', 'XSX', 'XSS'],
  NDS: ['NDS', 'DS', 'Nintendo DS', 'NDSi', 'DSi', 'ニンテンドーDS'],
  '3DS': ['3DS', 'Nintendo 3DS', '3DSLL', 'New 3DS', 'ニンテンドー3DS'],
  '2DS': ['2DS', 'Nintendo 2DS'],
  Wii: ['Wii', 'Nintendo Wii'],
  WiiU: ['WiiU', 'Wii U', 'Nintendo Wii U'],
  GC: ['GC', 'GameCube', 'NGC', 'Nintendo GameCube', 'ゲームキューブ'],
  GB: ['GB', 'Game Boy', 'ゲームボーイ'],
  GBC: ['GBC', 'Game Boy Color', 'GameBoy Color', 'ゲームボーイカラー'],
  GBA: ['GBA', 'Game Boy Advance', 'ゲームボーイアドバンス'],
  GG: ['GG', 'Game Gear', 'ゲームギア'],
  MD: ['MD', 'Mega Drive', 'Mega-CD', 'メガドライブ', 'Genesis'],
  '3DO': ['3DO', '3DO Interactive Multiplayer', 'Panasonic 3DO'],
  'FM-7': ['FM-7', 'FM7', 'FM77'],
  NeoGeo: ['Neo Geo', 'Neo Geo CD', 'NGCD', 'ネオジオ'],
  FC: ['FC', 'Famicom', 'Famicom Disk System', 'ファミコン', 'ファミリーコンピュータ'],
  SFC: ['SFC', 'Super Famicom', 'Super Nintendo', 'スーパーファミコン'],
  DC: ['DC', 'Dreamcast', 'ドリームキャスト'],
  SS: ['SS', 'Sega Saturn', 'Saturn', 'セガサターン'],
  PCE: ['PCE', 'PC Engine', 'PCエンジン', 'TurboGrafx-16'],
  'Neo Geo Pocket': ['Neo Geo Pocket', 'Neo Geo Pocket Color', 'NGP', 'NGPC'],
  'Sharp X68000': ['Sharp X68000', 'X68000', 'X68000PRO'],
  iOS: ['iOS', 'iPhone', 'iPad', 'iPadOS', 'iアプリ'],
  // Windows Phone 不能并进 Android：它是独立平台，并进去会让「搜 Windows 命中安卓游戏」
  // 且「搜 Android 命中 WP 游戏」。Symbian 同理，年代与生态都不同。
  Android: ['Android', '安卓', 'EZアプリ', 'S!アプリ', 'WX310K', 'SL2000', 'SL1500', 'Mobile Phone'],
  'Windows Phone': ['Windows Phone', 'WP', 'WP7', 'WP8', 'Windows Mobile'],
  Symbian: ['Symbian', 'Symbian OS', 'Series 60'],
  macOS: ['macOS', 'Mac', 'Mac OS', 'Mac OS X', 'OS X', 'Ubuntu', 'Linux', 'SteamOS', 'HarmonyOS NEXT'],
  Arcade: ['Arcade', 'アーケード', 'アーケードゲーム', 'AC', 'ARC', '街机', '業務用'],
  Web: ['Web', '在线网页', '网页', '浏览器', 'ブラウザ', 'HTML5', 'Game Archives', '手机浏览器', 'ISO'],
  Mobile: ['Mobile', '手机', '携帯', 'フィーチャーフォン', 'ガラケー'],
  'Oculus': ['Oculus', 'Oculus Rift', 'Oculus Go', 'Oculus Quest', 'Meta Quest'],
  'Steam VR': ['Steam VR', 'SteamVR', 'HTC Vive', 'Vive'],
  Arcade: ['Arcade', 'アーケード', 'アーケードゲーム', 'AC', '街机', '業務用'],
  Stadia: ['Stadia', 'Google Stadia'],
  'Shield TV': ['Shield TV', 'NVIDIA Shield'],
  ONS: ['ONS', 'ONScripter'],
  NP: ['NP', 'Nintendo Power'],
  文曲星: ['文曲星', 'Wenquxing'],
};

// 别名到标准名的反查（构建期用）
export const PLATFORM_LOOKUP = (() => {
  const m = new Map();
  Object.entries(PLATFORM_ALIAS).forEach(([std, list]) => {
    list.forEach((alias) => {
      const key = String(alias).trim().toLowerCase();
      if (!key) return;
      if (!m.has(key)) m.set(key, std);
    });
  });
  return m;
})();
