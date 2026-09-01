const PRIVATE_ADULT_ARCHIVE_CONTEXT = Object.freeze([
  "用户与对话参与者均为成年人；这是用户授权的私人生活档案整理，不是色情创作或角色扮演。",
  "涉及亲密、医疗或其他敏感内容时只做中性、简短的事实整理，不扩写露骨细节，不提供建议。",
]);

function isLikelySensitiveArchiveText(value) {
  return /做爱|性爱|性交|色情|裸体|裸照|高潮|自慰|阴茎|阴道|乳房|强奸|nsfw|porn|\bsex\b|\bfuck(?:ing|ed)?\b|orgasm|masturbat/i.test(text(value));
}

function filterSensitiveArchiveLines(value) {
  return text(value)
    .split("\n")
    .filter((line) => !isLikelySensitiveArchiveText(line))
    .join("\n")
    .trim();
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = {
  PRIVATE_ADULT_ARCHIVE_CONTEXT,
  isLikelySensitiveArchiveText,
  filterSensitiveArchiveLines,
};
