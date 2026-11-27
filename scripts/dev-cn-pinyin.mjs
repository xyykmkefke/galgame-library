// 纯中文开发商名的拼音别名：让「白露社」也能用 bailushe / bls 搜到。
// 由 scripts/build-alias-groups.mjs 调用，结果只灌进别名闭包，不改显示。
//
// 为什么单独一份、和 dev-romaji.mjs 分开：
//   罗马字是「日文假名 → 拉丁」的确定性转写，输入必须是假名；
//   拼音是「中文汉字 → 拉丁」，输入必须是汉字。
//   两者判据相反（一个见到汉字就跳过，一个只处理汉字），混在一起必然写错。
//
// 为什么只补「纯中文」社名：
//   日文社名里也含汉字（斜塔ソンブレロ / その恋），但那些字的读音要看日语习惯，
//   拿拼音去读是错的（「斜塔」日语读 shatou，拼音读 xieta）。
//   所以本文件要求：含汉字、**不含假名**、不含拉丁字母/数字，才算纯中文社名。
import { pinyin } from 'pinyin-pro';

const KANA = /[\u3040-\u30ff]/;
const HAN = /[\u3400-\u9fff]/;
const LATIN = /[A-Za-z0-9]/;

export function isChineseOnly(name) {
  const s = String(name || '');
  if (!s) return false;
  if (KANA.test(s)) return false;      // 含假名 → 日文社名，读音归日语
  if (LATIN.test(s)) return false;     // 含拉丁字母/数字 → 混合名，另有处理
  return HAN.test(s);
}

// 全拼：bailushe
function fullPinyin(s) {
  return pinyin(s, { toneType: 'none', type: 'array' })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// 首字母：bls
function initialPinyin(s) {
  return pinyin(s, { pattern: 'first', toneType: 'none', type: 'array' })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// 返回可并进别名闭包的全部写法（不含原名本身）。
//
// 门槛与 dev-romaji.mjs 保持一致，都是 3 个字符：
//   - 首字母必须 ≥3：「致意」→ zy、「双叶组」→ syz 里 zy 这种两字母值
//     一旦进表，搜两个字母就命中一大片无关条目，是纯噪音；
//   - 全拼天然都 ≥5（bailushe / zhiyi），门槛对它是无效约束，留着只为统一。
//
// 全拼一定要加：中文用户更可能打「bailushe」这种完整拼音找国产社团，
// 而首字母只在他们习惯用缩写时才用得上，两者都提供。
export function cnDevAliases(name) {
  if (!isChineseOnly(name)) return [];
  const out = new Set();
  const add = (v) => {
    const t = String(v || '').trim();
    if (t.length < 3) return;          // 3 字符门槛，同上
    out.add(t);
  };
  add(fullPinyin(name));
  add(initialPinyin(name));
  return [...out].filter((v) => v !== String(name));
}
