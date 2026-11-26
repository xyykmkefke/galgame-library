// 开发商跨语言别名：日文社名 -> 官方英文名（人工核对）
//
// 为什么需要单独一张表，而不写进 data/dev-alias.js：
//   dev-alias.js 的 map 是「写法 -> 标准名」，decorateData 会用它改写 x.dev，
//   因此会改变列表里显示的开发商名。这里的目标只是「让英文名能搜到」，
//   不改变显示，所以只灌进并查集（影响 dva），不进 map。
//
// 收录标准（三条都要满足）：
//   1. 是真实存在的日本公司/社团；
//   2. 英文名是官方名或业界长期通用的英文名（官网 / 维基可查）；
//   3. 当前数据里该社只以日文出现，搜英文名命中 0 条。
//
// 【明确不收录】
//   - 纯音译推测（サギヤマ -> Sagiyama 这类）：无法验证，写进去等于制造错误数据；
//   - 同人小社团无官方英文名（くまさんちーむ / ねこバナナ / たまごかけごはん）；
//   - 中文社名的拼音转写（白露社 -> Bailu She）：站点是中文界面，中文名本身就是正解。
//   宁缺勿错 —— 错误映射比搜不到更糟，用户会以为这就是官方名。
//
// 维护：新增后跑 `npm run build-alias-groups -- --apply` 重建别名组表。

export const DEV_CROSS_LANG = {
  // ---- 大型发行 / 开发商（官方英文名明确，可查证）----
  'バンダイナムコエンターテインメント': ['Bandai Namco Entertainment'],
  'バンダイナムコフィルムワークス': ['Bandai Namco Filmworks'],
  'バンダイナムコミュージックライブ': ['Bandai Namco Music Live'],
  'アトラス': ['Atlus'],
  'フリュー': ['Furyu'],
  'ブシロード': ['Bushiroad'],
  'アスキー・メディアワークス': ['ASCII Media Works'],
  'フロンティアワークス': ['Frontier Works'],
  'アクワイア': ['Acquire'],
  'エクスペリエンス': ['Experience'],
  'グラスホッパー・マニファクチュア': ['Grasshopper Manufacture'],
  'レベルファイブ': ['Level-5'],
  'プラチナゲームズ': ['PlatinumGames'],
  'ヴァニラウェア': ['Vanillaware'],
  'アークシステムワークス': ['Arc System Works'],
  'インテリジェントシステムズ': ['Intelligent Systems'],
  'フロム・ソフトウェア': ['FromSoftware'],
  'テクモ': ['Tecmo'],
  'チュンソフト': ['Chunsoft'],
  'アイディアファクトリー': ['Idea Factory'],
  'サイバーフロント': ['CyberFront'],
  'サイバーエージェント': ['CyberAgent'],
  'ドワンゴ': ['Dwango'],
  'アリスソフト': ['AliceSoft'],
  'システムソフト・アルファー': ['SystemSoft Alpha'],
  'ヘッドロック': ['Headlock'],
  'ハンズオン・エンタテインメント': ['Hands-On Entertainment'],
  'メディア・ビジョン': ['Media.Vision'],
  'ヒューネックス': ['HuneX'],
  'タムソフト': ['Tamsoft'],
  'クラフトエイジ': ['Craft Age'],
  'ジェー・シー・スタッフ': ['J.C.Staff'],
  'トンキンハウス': ['Tonkin House'],
  'ヒューマン': ['Human Entertainment'],
  'エコールソフトウェア': ['Ecole Software'],
  'チュアブルソフト': ['Chewable Soft'],
  'ジー・モード': ['G-Mode'],
  'ポケラボ': ['Pokelabo'],
  'シェード': ['Shade'],
  'ブリッジ': ['Bridge'],
  'キネティックノベルス': ['Kinetic Novels'],
  'ツェナワークス': ['Zener Works'],
  'グローディア': ['Glodia'],
  'ネクステック': ['Nextech'],
  'スピンネーカ': ['Spinnaker'],
  'ヌードメーカー': ['Nude Maker'],
  'イザナギゲームズ': ['IzanagiGames'],
  'フライングシャイン': ['Flying Shine'],
  'アクセスゲームズ': ['Access Games'],
  'サークルゴリッチュ': ['Circle Goritchu'],
  'ガムベース': ['GumBase'],
  'ピラミッド': ['Pyramid'],
  'プチデポット': ['Petit Depotto'],
  'オルタシウス': ['Altercius'],
  'クラシックショコラ': ['Classic Chocolate'],
  'けんこうランド': ['Kenko Land'],
  'ぶらんくのーと': ['Blank Note'],
  // 含汉字但英文名确定无疑的社（读音不靠猜，是官网/业界通用名）
  '日本ファルコム': ['Nihon Falcom', 'Falcom'],
  '上海アリス幻樂団': ['Team Shanghai Alice', 'Shanghai Alice'],
  'ガスト長野開発部': ['GUST', 'Gust'],
  '花梨エンターテイメント': ['Karin Entertainment'],
  '青空少女': ['Aozora Shoujo'],
};
