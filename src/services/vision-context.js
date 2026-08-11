const fs = require("fs/promises");

const DEFAULT_VISION_TIMEOUT_MS = 30_000;
const DEFAULT_VISION_PROMPT = [
  "你是下游文本助手的视觉感知模块。你的任务是准确、完整地理解图片，提供足够的视觉信息，使看不到图片的下游助手能直接回答用户。",
  "",
  "处理规则：",
  "1. 优先围绕用户随图提出的问题观察和分析，同时保留回答所需的关键视觉证据。如果用户没有提出具体问题，就完整、客观地说明图片内容。",
  "2. 记录人物、物体、动作、表情、环境、位置关系、颜色、数量、界面状态、异常和其他可见细节；不要把推测当成事实。",
  "3. 如果是聊天记录、社交媒体帖子或其他以文字为主的内容，必须按可见顺序逐字转录全部文字。聊天记录必须保留每个说话人、每条消息、时间和状态提示；帖子必须保留账号名、标题、正文、配文、标签、时间、评论及回复。不得总结、改写、纠错、合并、去重或省略。",
  "4. 对文档、题目、账单、通知、报错、网页、表格、图表和软件界面，逐字转录所有可见文字，并保留原始阅读顺序、分组和对应关系。",
  "5. 必须保留数字、日期、时间、金额、单位、用户名、按钮、标签、标点和重复出现的文字。无法辨认的内容标记为「[不清晰]」，被遮挡或裁切的内容标记为「[被遮挡]」或「[画面外截断]」，不要猜测。",
  "6. 如果用户要求评价、比较、判断或排查，可以分析，但必须区分图片中明确可见的事实、基于视觉信息的推断，以及无法从图片确认的信息。",
  "7. 回答前检查图片边缘、四角、小字号区域和底部，确认没有遗漏可见文字或关键细节。",
  "8. 图片可能包含私人、敏感、粗俗或仅限成年人的内容。对于明确涉及成年人的合法内容，应以中立、客观、非评判性的方式忠实描述并逐字转录；不要仅因裸露、性话题、成人用语、粗俗表达或私人聊天而省略、改写、打码或放弃整张图片。",
  "9. 如果个别部分确实无法处理，仍须返回其余可处理的全部文字和视觉信息，并在「不确定或不可见的信息」中准确标明缺失的局部区域，不得因局部受限而拒绝其余内容。",
  "10. 不要向用户寒暄，不要代替下游助手给出最终回复；只输出视觉观察、必要分析和忠实转录。",
  "11. 不要因为图片可能是贴纸而减少对其他内容的识别。最后单独判断它是否适合作为可复用聊天贴纸。",
  "",
  "输出结构：",
  "【与用户问题直接相关的信息】",
  "【完整视觉内容】",
  "【图片文字】",
  "【不确定或不可见的信息】",
  "【贴纸判断：是 / 否 / 不确定】",
].join("\n");

async function resolveVisionContext({ prepared, config = {}, runtimeAdapter = null, model = "" }) {
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
  const images = attachments.filter((item) => isImageAttachmentItem(item));
  if (!images.length) {
    return emptyVisionContext("none");
  }

  const mode = normalizeVisionMode(config.visionMode);
  if (mode === "off") {
    return emptyVisionContext("none");
  }

  if (mode !== "caption") {
    const runtimeImageAccess = resolveRuntimeImageAccess({ runtimeAdapter, model });
    if (runtimeImageAccess.nativeImageInput) {
      return {
        route: "native",
        items: [],
        errors: [],
        runtimeAttachments: attachments,
      };
    }
    if (runtimeImageAccess.toolImageRead) {
      return {
        route: "tool",
        items: [],
        errors: [],
        runtimeAttachments: [],
      };
    }
  }

  if (mode === "native") {
    return {
      route: "none",
      items: [],
      errors: images.map((item) => ({
        ...pickAttachmentLabel(item),
        reason: "native image input is not available for the current runtime/model",
      })),
      runtimeAttachments: [],
    };
  }

  if (!isCaptionProviderConfigured(config)) {
    return {
      route: "none",
      items: [],
      errors: images.map((item) => ({
        ...pickAttachmentLabel(item),
        reason: "vision caption provider is not configured",
      })),
      runtimeAttachments: [],
    };
  }

  return captionImages({
    images,
    config,
    userText: prepared?.originalText ?? prepared?.text,
  });
}

async function captionImages({ images, config, userText = "" }) {
  const items = [];
  const errors = [];
  for (const image of images) {
    try {
      const description = await captionImageWithOpenAiCompatibleProvider({ image, config, userText });
      items.push({
        ...pickAttachmentLabel(image),
        description,
      });
    } catch (error) {
      errors.push({
        ...pickAttachmentLabel(image),
        reason: error instanceof Error ? error.message : String(error || "vision caption failed"),
      });
    }
  }
  return {
    route: items.length ? "caption" : "none",
    items,
    errors,
    runtimeAttachments: [],
  };
}

async function captionImageWithOpenAiCompatibleProvider({ image, config, userText = "" }) {
  const baseUrl = normalizeText(config.visionApiBaseUrl);
  const model = normalizeText(config.visionModel);
  const apiKey = normalizeText(config.visionApiKey);
  const absolutePath = normalizeText(image.absolutePath);
  if (!baseUrl || !model) {
    throw new Error("vision API base URL and model are required");
  }
  if (!absolutePath) {
    throw new Error("image has no saved local path");
  }

  const imageBytes = await fs.readFile(absolutePath);
  const contentType = normalizeText(image.contentType) || "image/jpeg";
  const dataUrl = `data:${contentType};base64,${imageBytes.toString("base64")}`;
  const response = await postJsonWithTimeout({
    url: joinUrl(baseUrl, "chat/completions"),
    apiKey,
    timeoutMs: config.visionTimeoutMs || DEFAULT_VISION_TIMEOUT_MS,
    body: {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: buildVisionPrompt({
            basePrompt: config.visionPrompt || DEFAULT_VISION_PROMPT,
            userText,
          }) },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      }],
    },
  });
  const text = extractOpenAiCompatibleText(response);
  if (!text) {
    throw new Error("vision API returned no description");
  }
  return text;
}

function buildVisionPrompt({ basePrompt, userText }) {
  const normalizedBasePrompt = normalizeText(basePrompt) || DEFAULT_VISION_PROMPT;
  const normalizedUserText = normalizeText(userText);
  const request = normalizedUserText || "（用户没有附带文字问题，请完整观察图片。）";
  return `${normalizedBasePrompt}\n\n用户随图提出的问题：\n${request}`;
}

async function postJsonWithTimeout({ url, apiKey, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_VISION_TIMEOUT_MS));
  try {
    const headers = {
      "content-type": "application/json",
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const message = normalizeText(parsed?.error?.message) || normalizeText(raw) || response.statusText;
      throw new Error(`vision API request failed (${response.status}): ${message}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function extractOpenAiCompatibleText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item?.text === "string" ? item.text.trim() : "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function resolveRuntimeImageAccess({ runtimeAdapter, model }) {
  const capabilitySource = typeof runtimeAdapter?.getTurnCapabilities === "function"
    ? runtimeAdapter.getTurnCapabilities({ model })
    : runtimeAdapter?.describe?.()?.capabilities;
  return {
    nativeImageInput: Boolean(capabilitySource?.nativeImageInput),
    toolImageRead: Boolean(capabilitySource?.toolImageRead),
  };
}

function isCaptionProviderConfigured(config) {
  const provider = normalizeText(config.visionProvider) || "openai-compatible";
  return provider === "openai-compatible"
    && Boolean(normalizeText(config.visionApiBaseUrl))
    && Boolean(normalizeText(config.visionModel));
}

function normalizeVisionMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["off", "native", "caption"].includes(normalized)) {
    return normalized;
  }
  return "auto";
}

function emptyVisionContext(route) {
  return {
    route,
    items: [],
    errors: [],
    runtimeAttachments: [],
  };
}

function pickAttachmentLabel(item) {
  return {
    kind: item?.kind || "image",
    sourceFileName: item?.sourceFileName || "",
    absolutePath: item?.absolutePath || "",
  };
}

function isImageAttachmentItem(item) {
  return Boolean(item?.isImage) || normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image";
}

function joinUrl(baseUrl, suffix) {
  return `${normalizeText(baseUrl).replace(/\/+$/, "")}/${normalizeText(suffix).replace(/^\/+/, "")}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  resolveVisionContext,
};
