import type {
  ImageGenerationProtocol,
  MusicGenerationProtocol,
  ModelEndpointFormat,
  ModelProviderImageCapabilityV1,
  ModelProviderMusicCapabilityV1,
  ModelProviderModelProfileV1,
  ModelProviderPresetMode,
  ModelProviderProfileV1,
  ModelProviderReasoningCapabilityV1,
  ModelProviderSpeechCapabilityV1,
  ModelProviderTextToSpeechCapabilityV1,
  ModelProviderVideoCapabilityV1,
  SpeechToTextProtocol,
  TextToSpeechProtocol,
  VideoGenerationProtocol
} from './app-settings-types'
import {
  DEFAULT_MODEL_REQUEST_RETRY_HTTP_STATUS_CODES,
  DEFAULT_MODEL_REQUEST_RETRY_INITIAL_DELAY_MS,
  DEFAULT_MODEL_REQUEST_RETRY_MAX_ATTEMPTS
} from './app-settings-types'

export type ModelProviderPresetId =
  | 'litellm'
  | 'longcat'
  | 'zhipu-coding-plan'
  | 'zai-coding-plan'
  | 'kimi-code'
  | 'volcengine-coding-plan'
  | 'opencode-go'
  | 'codex'
  | 'claude-subscription'
  | 'gemini-subscription'
  | 'gemini-cli-subscription'
  | 'cursor-subscription'
  | 'ollama'
  | 'grok-subscription'
  | 'moonshot-cn'
  | 'moonshot-global'
  | 'xiaomi'
  | 'minimax'
  | 'aliyun'
  | 'tencentcloud'
  | 'vercel-ai-gateway'

export const TOKEN_PLAN_PROVIDER_ID_SUFFIX = '-token-plan'

export const CHATGPT_SUBSCRIPTION_PROVIDER_ID = 'codex'
export const CHATGPT_SUBSCRIPTION_LEGACY_NAME = 'Codex (ChatGPT)'
export const CHATGPT_SUBSCRIPTION_NAME = 'ChatGPT 订阅'
export const GROK_SUBSCRIPTION_PROVIDER_ID = 'grok-subscription'
export const GROK_SUBSCRIPTION_NAME = 'Grok 订阅'
export const GEMINI_SUBSCRIPTION_PROVIDER_ID = 'gemini-subscription'
export const GEMINI_SUBSCRIPTION_NAME = 'Google Antigravity 订阅'
export const GEMINI_CLI_SUBSCRIPTION_PROVIDER_ID = 'gemini-cli-subscription'
export const GEMINI_CLI_SUBSCRIPTION_NAME = 'Gemini CLI 订阅（API）'
export const CURSOR_SUBSCRIPTION_PROVIDER_ID = 'cursor-subscription'
export const CURSOR_SUBSCRIPTION_NAME = 'Cursor 订阅'
export const CURSOR_SUBSCRIPTION_MODEL_IDS = ['auto'] as const
export const OLLAMA_CLOUD_PROVIDER_ID = 'ollama'
export const OLLAMA_CLOUD_PROVIDER_NAME = 'Ollama Cloud'
// Bootstrap snapshot from Ollama Cloud's official GET /v1/models response.
// The live endpoint remains authoritative and Settings can import additions.
export const OLLAMA_CLOUD_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'gemma4:31b',
  'glm-5.1',
  'glm-5.2',
  'gpt-oss:120b',
  'gpt-oss:20b',
  'kimi-k2.5',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'mistral-large-3:675b',
  'nemotron-3-nano:30b',
  'nemotron-3-super',
  'nemotron-3-ultra',
  'qwen3.5:397b'
] as const
export const GEMINI_SUBSCRIPTION_MODEL_IDS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro'
] as const
// Concrete model ids accepted by the official Gemini CLI Code Assist API
// path. Keep this catalog independent from Antigravity's `agy models` output:
// the two transports can expose different releases to the same Google account.
export const GEMINI_CLI_SUBSCRIPTION_MODEL_IDS = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash'
] as const
export const GROK_SUBSCRIPTION_MODEL_IDS = [
  'grok-4.5',
  'grok-4-1-fast-reasoning',
  'grok-4-1-fast-non-reasoning',
  'grok-code-fast-1'
] as const
export const CHATGPT_SUBSCRIPTION_LEGACY_MODEL_IDS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark'
] as const
export const CHATGPT_SUBSCRIPTION_MODEL_IDS = [
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark'
] as const

export type ModelProviderTokenPlanRegion = {
  id: string
  baseUrl: string
}

export type ModelProviderSubscriptionRegion = 'china' | 'united-states'

/**
 * Subscription ("Token Plan") access mode. Providers issue separate keys for
 * subscription and pay-as-you-go calls, so this maps to its own provider
 * profile (`<presetId>-token-plan`) instead of a flag on the main profile.
 * Capabilities (speech/image) are included when subscription keys can access
 * the resource. Some resources use their own endpoint instead of the chat
 * endpoint, so each capability may carry a separate base URL.
 */
export type ModelProviderTokenPlanPreset = {
  baseUrl: string
  /** Regional clusters. When present, baseUrl must equal the first region's baseUrl. */
  regions?: ModelProviderTokenPlanRegion[]
  endpointFormat: ModelEndpointFormat
  models: string[]
  modelProfiles?: Record<string, ModelProviderModelProfileV1>
  /** Speech capability served by the plan endpoint itself (baseUrl follows the plan baseUrl). */
  speech?: {
    protocol: SpeechToTextProtocol
    models: string[]
  }
  image?: {
    protocol: ImageGenerationProtocol
    baseUrl: string
    models: string[]
  }
  textToSpeech?: {
    protocol: TextToSpeechProtocol
    baseUrl?: string
    models: string[]
  }
  music?: {
    protocol: MusicGenerationProtocol
    baseUrl: string
    models: string[]
  }
  video?: {
    protocol: VideoGenerationProtocol
    baseUrl: string
    models: string[]
  }
  /** Expected key prefix, e.g. "tp-". Hint only, never enforced. */
  keyPrefix?: string
  apiKeyUrl: string
}

export type ModelProviderPreset = {
  id: ModelProviderPresetId
  name: string
  /**
   * 计费/接入大类。'subscription' = 固定费用套餐(Coding Plan、Token Plan 这类),
   * 'api'(默认) = 按量付费。仅用于设置页把套餐类供应商收拢成一组,不写入存储的 profile。
   */
  category?: 'api' | 'subscription'
  /**
   * 套餐订阅筛选所使用的供应商归属地区。仅用于预设选择器展示，不写入 provider profile。
   * 同一个预设的 Token Plan 入口沿用这里的地区。
   */
  subscriptionRegion?: ModelProviderSubscriptionRegion
  /**
   * 传输类型。'agent-sdk' = 把整轮委托给内置的官方 Claude Agent SDK(消耗 Claude
   * Pro/Max 订阅额度,合规路径);'antigravity-cli' = 把整轮委托给 Google 官方
   * Antigravity CLI(使用 Gemini 订阅);'gemini-cli-api' = 复用官方 Gemini CLI
   * OAuth 登录并直接调用 Code Assist API,由 Kun 保留 agent loop;'cursor-sdk' =
   * 使用 Cursor API Key 把整轮委托给官方 Cursor SDK;缺省按 HTTP 模型客户端走 baseUrl。
   */
  kind?: 'agent-sdk' | 'antigravity-cli' | 'gemini-cli-api' | 'cursor-sdk'
  baseUrl: string
  endpointFormat: ModelEndpointFormat
  models: string[]
  modelProfiles?: Record<string, ModelProviderModelProfileV1>
  image?: {
    protocol: ImageGenerationProtocol
    baseUrl: string
    models: string[]
  }
  speech?: {
    protocol: SpeechToTextProtocol
    baseUrl: string
    models: string[]
  }
  textToSpeech?: {
    protocol: TextToSpeechProtocol
    baseUrl: string
    models: string[]
  }
  music?: {
    protocol: MusicGenerationProtocol
    baseUrl: string
    models: string[]
  }
  video?: {
    protocol: VideoGenerationProtocol
    baseUrl: string
    models: string[]
  }
  tokenPlan?: ModelProviderTokenPlanPreset
  docsUrl: string
  apiKeyUrl: string
}

// 这些 const 必须在 MODEL_PROVIDER_PRESETS 之前声明:
// 数组初始化时就会调用下面的 profile 工厂函数,声明在后会触发 TDZ。
const XIAOMI_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['off', 'low', 'medium', 'high'],
  defaultEffort: 'high',
  requestProtocol: 'mimo-chat-completions'
}

const MINIMAX_M3_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['auto', 'off'],
  defaultEffort: 'auto',
  requestProtocol: 'anthropic-thinking'
}

const MINIMAX_BUILT_IN_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['auto'],
  defaultEffort: 'auto',
  requestProtocol: 'none'
}

const GLM_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['off', 'high', 'max'],
  defaultEffort: 'max',
  requestProtocol: 'glm-chat-completions'
}

const DEEPSEEK_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['off', 'high', 'max'],
  defaultEffort: 'max',
  requestProtocol: 'deepseek-chat-completions'
}

const ANTIGRAVITY_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  // The delegated runtime maps this to `agy --effort`; the HTTP request
  // protocol is intentionally unused.
  requestProtocol: 'none'
}

const GEMINI_CLI_API_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['off', 'low', 'medium', 'high'],
  defaultEffort: 'medium',
  // The dedicated Gemini CLI API adapter maps this to generationConfig.thinkingConfig.
  requestProtocol: 'none'
}

export const CURSOR_SDK_ADAPTIVE_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['auto'],
  defaultEffort: 'auto',
  // Cursor's Agent SDK owns the model-specific thinking parameters. Omitting
  // explicit SDK params preserves its adaptive default for every model family.
  requestProtocol: 'none'
}

// 通义千问 / 混元 / 豆包的「思考」开关各家用私有 body 字段,无法用现有 requestProtocol 精确映射,
// 这里统一按「内置推理」建模(requestProtocol: 'none'):只展示 effort 开关、不向上游发送特定协议字段,避免请求被拒。
const QWEN_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['auto', 'off'],
  defaultEffort: 'auto',
  requestProtocol: 'none'
}

const HUNYUAN_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['auto', 'off'],
  defaultEffort: 'auto',
  requestProtocol: 'none'
}

const DOUBAO_REASONING: ModelProviderReasoningCapabilityV1 = {
  supportedEfforts: ['auto', 'off'],
  defaultEffort: 'auto',
  requestProtocol: 'none'
}

const ZHIPU_CODING_PLAN_MODELS = [
  'glm-5.2',
  'glm-5.1',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.5-air'
]

const ZAI_CODING_PLAN_MODELS = [
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.5-air'
]

const MOONSHOT_CHAT_MODELS = [
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
  'moonshot-v1-128k',
  'moonshot-v1-32k',
  'moonshot-v1-8k'
]

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    id: 'litellm',
    name: 'LiteLLM',
    baseUrl: 'http://localhost:4000',
    endpointFormat: 'chat_completions',
    models: [],
    docsUrl: 'https://docs.litellm.ai/docs/',
    apiKeyUrl: 'https://docs.litellm.ai/docs/proxy/quick_start'
  },
  {
    id: 'longcat',
    name: 'LongCat',
    baseUrl: 'https://api.longcat.chat/openai',
    endpointFormat: 'chat_completions',
    models: ['LongCat-2.0-Preview'],
    modelProfiles: {
      'LongCat-2.0-Preview': textChatProfile(1_000_000)
    },
    docsUrl: 'https://longcat.chat/platform/docs/zh/',
    apiKeyUrl: 'https://longcat.chat/platform/'
  },
  {
    id: 'claude-subscription',
    name: 'Claude (Pro/Max 订阅)',
    category: 'subscription',
    subscriptionRegion: 'united-states',
    // Delegates whole turns to the official Claude Agent SDK so requests draw on
    // the user's Claude subscription. baseUrl is unused for this kind (kept for
    // display); auth comes from the host's Claude Code login or a pasted
    // CLAUDE_CODE_OAUTH_TOKEN in the API Key field.
    kind: 'agent-sdk',
    baseUrl: 'https://api.anthropic.com',
    endpointFormat: 'messages',
    // Ids match what the SDK's supportedModels() returns (see claude-subscription-models).
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    // The SDK does NOT report a context window, so we set it manually: Opus 4.8 and
    // Sonnet 4.x support 1M; Haiku 4.5 is 200K. All Claude 4.x models are vision-capable,
    // so every profile uses visionChatProfile (inputModalities text+image). Cosmetic on
    // the agent-sdk path (the SDK enforces the real limit); preset profiles are
    // authoritative, so edit them here.
    modelProfiles: {
      'claude-opus-4-8': visionChatProfile(1_000_000),
      'claude-sonnet-4-6': visionChatProfile(1_000_000),
      'claude-haiku-4-5': visionChatProfile(200_000)
    },
    docsUrl: 'https://code.claude.com/docs/en/authentication',
    apiKeyUrl: 'https://claude.ai'
  },
  {
    id: GEMINI_SUBSCRIPTION_PROVIDER_ID,
    name: GEMINI_SUBSCRIPTION_NAME,
    category: 'subscription',
    subscriptionRegion: 'united-states',
    // Antigravity subscription models are served by Google's official
    // Antigravity CLI. Do not route this provider's ids through the separate
    // Gemini CLI Code Assist API transport or the public API-key endpoint.
    kind: 'antigravity-cli',
    baseUrl: '',
    endpointFormat: 'custom_endpoint',
    models: [...GEMINI_SUBSCRIPTION_MODEL_IDS],
    modelProfiles: Object.fromEntries(
      GEMINI_SUBSCRIPTION_MODEL_IDS.map((model) => [
        model,
        visionChatProfile(1_048_576, ANTIGRAVITY_REASONING)
      ])
    ),
    docsUrl: 'https://github.com/google-antigravity/antigravity-cli',
    apiKeyUrl: 'https://antigravity.google'
  },
  {
    id: GEMINI_CLI_SUBSCRIPTION_PROVIDER_ID,
    name: GEMINI_CLI_SUBSCRIPTION_NAME,
    category: 'subscription',
    subscriptionRegion: 'united-states',
    // Reuses the official Gemini CLI's OAuth credential and direct Code Assist
    // API contract. This is a native Kun model transport, not an Antigravity
    // whole-turn delegation and not the public API-key endpoint.
    kind: 'gemini-cli-api',
    baseUrl: '',
    endpointFormat: 'custom_endpoint',
    models: [...GEMINI_CLI_SUBSCRIPTION_MODEL_IDS],
    modelProfiles: Object.fromEntries(
      GEMINI_CLI_SUBSCRIPTION_MODEL_IDS.map((model) => [
        model,
        visionChatProfile(1_048_576, GEMINI_CLI_API_REASONING)
      ])
    ),
    speech: {
      protocol: 'gemini-cli-audio',
      baseUrl: '',
      models: [...GEMINI_CLI_SUBSCRIPTION_MODEL_IDS]
    },
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    apiKeyUrl: 'https://github.com/google-gemini/gemini-cli#authentication-options'
  },
  {
    id: CURSOR_SUBSCRIPTION_PROVIDER_ID,
    name: CURSOR_SUBSCRIPTION_NAME,
    category: 'subscription',
    subscriptionRegion: 'united-states',
    // Cursor exposes an official Agent SDK instead of an OpenAI-compatible
    // subscription endpoint. Account-visible models are pulled after the user
    // supplies a Cursor API key; `auto` remains the offline fallback.
    kind: 'cursor-sdk',
    baseUrl: '',
    endpointFormat: 'custom_endpoint',
    models: [...CURSOR_SUBSCRIPTION_MODEL_IDS],
    modelProfiles: {
      auto: textChatProfile(undefined, CURSOR_SDK_ADAPTIVE_REASONING)
    },
    docsUrl: 'https://cursor.com/docs/api/sdk/typescript',
    apiKeyUrl: 'https://cursor.com/dashboard/api?section=user-keys#user-api-keys'
  },
  {
    id: OLLAMA_CLOUD_PROVIDER_ID,
    name: OLLAMA_CLOUD_PROVIDER_NAME,
    category: 'subscription',
    subscriptionRegion: 'united-states',
    // Ollama Cloud documents an OpenAI-compatible surface, so Kun can retain
    // its single HTTP model loop (streaming, tools, images, and usage) instead
    // of adding a parallel native /api/chat transport.
    baseUrl: 'https://ollama.com/v1',
    endpointFormat: 'chat_completions',
    models: [...OLLAMA_CLOUD_MODEL_IDS],
    docsUrl: 'https://docs.ollama.com/cloud',
    apiKeyUrl: 'https://ollama.com/settings/keys'
  },
  {
    id: 'zhipu-coding-plan',
    name: 'Zhipu Coding Plan',
    category: 'subscription',
    subscriptionRegion: 'china',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    endpointFormat: 'custom_endpoint',
    models: [...ZHIPU_CODING_PLAN_MODELS],
    modelProfiles: {
      'glm-5.2': textChatProfile(1_000_000, GLM_REASONING),
      'glm-5.1': textChatProfile(200_000, GLM_REASONING),
      'glm-5-turbo': textChatProfile(200_000, GLM_REASONING),
      'glm-4.7': textChatProfile(200_000, GLM_REASONING),
      'glm-4.5-air': textChatProfile(200_000, GLM_REASONING)
    },
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys'
  },
  {
    id: 'zai-coding-plan',
    name: 'Z.ai Coding Plan',
    category: 'subscription',
    subscriptionRegion: 'china',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    endpointFormat: 'custom_endpoint',
    models: [...ZAI_CODING_PLAN_MODELS],
    modelProfiles: {
      'glm-5.2': textChatProfile(1_000_000, GLM_REASONING),
      'glm-5.1': textChatProfile(200_000, GLM_REASONING),
      'glm-5': textChatProfile(200_000, GLM_REASONING),
      'glm-5-turbo': textChatProfile(200_000, GLM_REASONING),
      'glm-4.7': textChatProfile(200_000, GLM_REASONING),
      'glm-4.5-air': textChatProfile(200_000, GLM_REASONING)
    },
    docsUrl: 'https://docs.z.ai/devpack/tool/others',
    apiKeyUrl: 'https://z.ai/subscribe'
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    category: 'subscription',
    subscriptionRegion: 'china',
    baseUrl: 'https://api.kimi.com/coding/v1',
    endpointFormat: 'chat_completions',
    models: ['kimi-for-coding'],
    modelProfiles: {
      'kimi-for-coding': textChatProfile()
    },
    docsUrl: 'https://www.kimi.com/code/docs/en/',
    apiKeyUrl: 'https://www.kimi.com/code'
  },
  {
    id: 'volcengine-coding-plan',
    name: 'Volcano Ark Coding Plan',
    category: 'subscription',
    subscriptionRegion: 'china',
    // 火山方舟 Coding Plan 与按量付费共用同一个 API Key,但套餐额度只在 /api/coding 网关上消费;
    // 用按量 base(/api/v3)调用会按量计费。官方注明套餐额度仅限编程工具(Claude Code / Cursor 等)使用。
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    endpointFormat: 'chat_completions',
    models: ['doubao-seed-1-6-250615', 'doubao-seed-1-6-flash-250828'],
    modelProfiles: {
      'doubao-seed-1-6-250615': visionChatProfile(256_000, DOUBAO_REASONING),
      'doubao-seed-1-6-flash-250828': textChatProfile(256_000, DOUBAO_REASONING)
    },
    docsUrl: 'https://www.volcengine.com/docs/82379/1928262',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    category: 'subscription',
    subscriptionRegion: 'united-states',
    // 网关默认走 chat_completions;MiniMax / Qwen 系列在 OpenCode Go 上以
    // Anthropic Messages 格式提供,故按模型用 endpointFormat:'messages' 覆盖
    // (请求改打 …/zen/go/v1/messages)。
    baseUrl: 'https://opencode.ai/zen/go/v1',
    endpointFormat: 'chat_completions',
    models: [
      'glm-5.1',
      'glm-5',
      'kimi-k2.7',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'mimo-v2-pro',
      'mimo-v2-omni',
      'minimax-m3',
      'minimax-m2.7',
      'minimax-m2.5',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3.5-plus'
    ],
    modelProfiles: {
      'glm-5.1': visionChatProfile(131_072),
      'glm-5': visionChatProfile(131_072),
      'kimi-k2.7': textChatProfile(131_072),
      'kimi-k2.7-code': textChatProfile(131_072),
      'kimi-k2.6': textChatProfile(131_072),
      'deepseek-v4-pro': textChatProfile(1_000_000, DEEPSEEK_REASONING),
      'deepseek-v4-flash': textChatProfile(1_000_000, DEEPSEEK_REASONING),
      'mimo-v2.5': textChatProfile(131_072),
      'mimo-v2.5-pro': textChatProfile(131_072),
      'mimo-v2-pro': textChatProfile(131_072),
      'mimo-v2-omni': visionChatProfile(131_072),
      'minimax-m3': textChatProfile(256_000, undefined, 'messages'),
      'minimax-m2.7': textChatProfile(256_000, undefined, 'messages'),
      'minimax-m2.5': textChatProfile(256_000, undefined, 'messages'),
      'qwen3.7-max': textChatProfile(262_144, undefined, 'messages'),
      'qwen3.7-plus': textChatProfile(262_144, undefined, 'messages'),
      'qwen3.6-plus': textChatProfile(262_144, undefined, 'messages'),
      'qwen3.5-plus': textChatProfile(262_144, undefined, 'messages')
    },
    docsUrl: 'https://opencode.ai/docs/go/',
    apiKeyUrl: 'https://opencode.ai/auth'
  },
  {
    id: 'moonshot-cn',
    name: 'Moonshot CN',
    baseUrl: 'https://api.moonshot.cn/v1',
    endpointFormat: 'chat_completions',
    models: [...MOONSHOT_CHAT_MODELS],
    modelProfiles: {
      'kimi-k2.7-code': visionChatProfile(),
      'kimi-k2.6': visionChatProfile(),
      'kimi-k2.5': visionChatProfile(),
      'moonshot-v1-128k': textChatProfile(128_000),
      'moonshot-v1-32k': textChatProfile(32_000),
      'moonshot-v1-8k': textChatProfile(8_000)
    },
    docsUrl: 'https://platform.moonshot.cn/docs',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'moonshot-global',
    name: 'Moonshot Global',
    baseUrl: 'https://api.moonshot.ai/v1',
    endpointFormat: 'chat_completions',
    models: [...MOONSHOT_CHAT_MODELS],
    modelProfiles: {
      'kimi-k2.7-code': visionChatProfile(),
      'kimi-k2.6': visionChatProfile(),
      'kimi-k2.5': visionChatProfile(),
      'moonshot-v1-128k': textChatProfile(128_000),
      'moonshot-v1-32k': textChatProfile(32_000),
      'moonshot-v1-8k': textChatProfile(8_000)
    },
    docsUrl: 'https://platform.moonshot.ai/docs',
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys'
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi',
    subscriptionRegion: 'china',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    endpointFormat: 'chat_completions',
    models: [
      'mimo-v2.5-pro',
      'mimo-v2.5',
      'mimo-v2-pro',
      'mimo-v2-omni'
    ],
    modelProfiles: {
      'mimo-v2.5-pro': xiaomiTextChatProfile(1_000_000),
      'mimo-v2.5': xiaomiVisionChatProfile(1_000_000),
      'mimo-v2-pro': xiaomiTextChatProfile(1_000_000),
      'mimo-v2-omni': xiaomiVisionChatProfile(256_000)
    },
    speech: {
      protocol: 'mimo-asr',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      models: ['mimo-v2.5-asr']
    },
    textToSpeech: {
      protocol: 'mimo-tts',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone']
    },
    tokenPlan: {
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      regions: [
        { id: 'cn', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
        { id: 'sgp', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' },
        { id: 'ams', baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1' }
      ],
      endpointFormat: 'chat_completions',
      models: [
        'mimo-v2.5-pro',
        'mimo-v2.5',
        'mimo-v2-pro',
        'mimo-v2-omni'
      ],
      modelProfiles: {
        'mimo-v2.5-pro': xiaomiTextChatProfile(1_000_000),
        'mimo-v2.5': xiaomiVisionChatProfile(1_000_000),
        'mimo-v2-pro': xiaomiTextChatProfile(1_000_000),
        'mimo-v2-omni': xiaomiVisionChatProfile(256_000)
      },
      speech: {
        protocol: 'mimo-asr',
        models: ['mimo-v2.5-asr']
      },
      textToSpeech: {
        protocol: 'mimo-tts',
        models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone']
      },
      keyPrefix: 'tp-',
      apiKeyUrl: 'https://platform.xiaomimimo.com/docs/en-US/price/tokenplan/quick-access'
    },
    docsUrl: 'https://platform.xiaomimimo.com/#/docs',
    apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    subscriptionRegion: 'china',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    endpointFormat: 'messages',
    models: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2'
    ],
    modelProfiles: {
      'MiniMax-M3': minimaxM3ChatProfile(),
      'MiniMax-M2.7': minimaxM2ChatProfile(),
      'MiniMax-M2.7-highspeed': minimaxM2ChatProfile(),
      'MiniMax-M2.5': minimaxM2ChatProfile(),
      'MiniMax-M2.5-highspeed': minimaxM2ChatProfile(),
      'MiniMax-M2.1': minimaxM2ChatProfile(),
      'MiniMax-M2.1-highspeed': minimaxM2ChatProfile(),
      'MiniMax-M2': minimaxM2ChatProfile()
    },
    image: {
      protocol: 'minimax-image',
      baseUrl: 'https://api.minimaxi.com',
      models: ['image-01', 'image-01-live']
    },
    textToSpeech: {
      protocol: 'minimax-t2a',
      baseUrl: 'https://api.minimax.io',
      models: ['speech-2.8-hd', 'speech-2.8-turbo']
    },
    music: {
      protocol: 'minimax-music',
      baseUrl: 'https://api.minimax.io',
      models: ['music-2.6', 'music-cover', 'music-2.6-free', 'music-cover-free']
    },
    video: {
      protocol: 'minimax-video',
      baseUrl: 'https://api.minimax.io',
      models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast']
    },
    tokenPlan: {
      baseUrl: 'https://api.minimaxi.com/anthropic',
      regions: [
        { id: 'cn', baseUrl: 'https://api.minimaxi.com/anthropic' },
        { id: 'global', baseUrl: 'https://api.minimax.io/anthropic' }
      ],
      endpointFormat: 'messages',
      models: [
        'MiniMax-M3',
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M2.1',
        'MiniMax-M2.1-highspeed',
        'MiniMax-M2'
      ],
      modelProfiles: {
        'MiniMax-M3': minimaxM3ChatProfile(),
        'MiniMax-M2.7': minimaxM2ChatProfile(),
        'MiniMax-M2.7-highspeed': minimaxM2ChatProfile(),
        'MiniMax-M2.5': minimaxM2ChatProfile(),
        'MiniMax-M2.5-highspeed': minimaxM2ChatProfile(),
        'MiniMax-M2.1': minimaxM2ChatProfile(),
        'MiniMax-M2.1-highspeed': minimaxM2ChatProfile(),
        'MiniMax-M2': minimaxM2ChatProfile()
      },
      image: {
        protocol: 'minimax-image',
        baseUrl: 'https://api.minimaxi.com',
        models: ['image-01', 'image-01-live']
      },
      textToSpeech: {
        protocol: 'minimax-t2a',
        baseUrl: 'https://api.minimax.io',
        models: ['speech-2.8-hd', 'speech-2.8-turbo']
      },
      music: {
        protocol: 'minimax-music',
        baseUrl: 'https://api.minimax.io',
        models: ['music-2.6', 'music-cover', 'music-2.6-free', 'music-cover-free']
      },
      video: {
        protocol: 'minimax-video',
        baseUrl: 'https://api.minimax.io',
        models: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-2.3-Fast']
      },
      apiKeyUrl: 'https://platform.minimaxi.com/docs/token-plan/quickstart'
    },
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-anthropic-api',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
  },
  {
    id: 'aliyun',
    name: 'Aliyun',
    subscriptionRegion: 'china',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    endpointFormat: 'chat_completions',
    models: [
      'qwen-max',
      'qwen-plus',
      'qwen-flash',
      'qwen3-coder-plus',
      'qwq-plus',
      'qwen-vl-max',
      'qwen3-vl-plus'
    ],
    modelProfiles: {
      'qwen-max': textChatProfile(262_144),
      'qwen-plus': textChatProfile(1_000_000),
      'qwen-flash': textChatProfile(1_000_000),
      'qwen3-coder-plus': textChatProfile(1_000_000),
      'qwq-plus': textChatProfile(131_072, QWEN_REASONING),
      'qwen-vl-max': visionChatProfile(131_072),
      'qwen3-vl-plus': visionChatProfile(262_144, QWEN_REASONING)
    },
    tokenPlan: {
      // 通义千问 Token Plan(团队版):独立 Key + 独立 base URL,与按量 sk- Key 不互通。
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      regions: [
        { id: 'cn', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
        { id: 'sgp', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' }
      ],
      endpointFormat: 'chat_completions',
      models: [
        'qwen-max',
        'qwen-plus',
        'qwen-flash',
        'qwen3-coder-plus',
        'qwq-plus',
        'qwen-vl-max',
        'qwen3-vl-plus'
      ],
      modelProfiles: {
        'qwen-max': textChatProfile(262_144),
        'qwen-plus': textChatProfile(1_000_000),
        'qwen-flash': textChatProfile(1_000_000),
        'qwen3-coder-plus': textChatProfile(1_000_000),
        'qwq-plus': textChatProfile(131_072, QWEN_REASONING),
        'qwen-vl-max': visionChatProfile(131_072),
        'qwen3-vl-plus': visionChatProfile(262_144, QWEN_REASONING)
      },
      apiKeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key'
    },
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    apiKeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key'
  },
  {
    id: 'tencentcloud',
    name: 'Tencent Cloud',
    subscriptionRegion: 'china',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    endpointFormat: 'chat_completions',
    models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest', 'hunyuan-lite'],
    modelProfiles: {
      'hunyuan-turbos-latest': textChatProfile(32_768),
      'hunyuan-t1-latest': textChatProfile(32_768, HUNYUAN_REASONING),
      'hunyuan-lite': textChatProfile(256_000)
    },
    tokenPlan: {
      // 腾讯混元 Token Plan(TokenHub):独立 sk-tp- Key + 独立 base URL,与按量 sk- Key 不互通。
      baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3',
      endpointFormat: 'chat_completions',
      models: ['hunyuan-turbos-latest', 'hunyuan-t1-latest', 'hunyuan-lite'],
      modelProfiles: {
        'hunyuan-turbos-latest': textChatProfile(32_768),
        'hunyuan-t1-latest': textChatProfile(32_768, HUNYUAN_REASONING),
        'hunyuan-lite': textChatProfile(256_000)
      },
      keyPrefix: 'sk-tp-',
      apiKeyUrl: 'https://console.cloud.tencent.com/tokenhub/tokenplan'
    },
    docsUrl: 'https://cloud.tencent.com/document/product/1729/111006',
    apiKeyUrl: 'https://console.cloud.tencent.com/hunyuan/start'
  },
  {
    id: CHATGPT_SUBSCRIPTION_PROVIDER_ID,
    name: CHATGPT_SUBSCRIPTION_NAME,
    category: 'subscription',
    subscriptionRegion: 'united-states',
    baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
    endpointFormat: 'custom_endpoint',
    models: [...CHATGPT_SUBSCRIPTION_MODEL_IDS],
    modelProfiles: {
      'gpt-5.5': visionChatProfile(1_000_000),
      'gpt-5.6-sol': codexLiteVisionChatProfile(372_000),
      'gpt-5.6-terra': codexLiteVisionChatProfile(372_000),
      'gpt-5.6-luna': codexLiteVisionChatProfile(372_000),
      'gpt-5.4': visionChatProfile(1_000_000),
      'gpt-5.4-mini': visionChatProfile(1_000_000),
      'gpt-5.3-codex-spark': textChatProfile(128_000)
    },
    image: {
      protocol: 'codex-responses-image',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini']
    },
    docsUrl: 'https://openai.com/index/codex/',
    apiKeyUrl: 'https://chatgpt.com'
  },
  {
    id: GROK_SUBSCRIPTION_PROVIDER_ID,
    name: GROK_SUBSCRIPTION_NAME,
    category: 'subscription',
    subscriptionRegion: 'united-states',
    // Session OAuth tokens must hit cli-chat-proxy (subscription quota). Pay-as-you-go
    // XAI_API_KEY traffic uses https://api.x.ai/v1 instead — keep them separate.
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    endpointFormat: 'responses',
    models: [...GROK_SUBSCRIPTION_MODEL_IDS],
    modelProfiles: {
      'grok-4.5': visionChatProfile(500_000),
      'grok-4-1-fast-reasoning': visionChatProfile(2_000_000),
      'grok-4-1-fast-non-reasoning': visionChatProfile(2_000_000),
      'grok-code-fast-1': textChatProfile(256_000)
    },
    // Grok Build deliberately sends subscription OAuth bearers directly to the
    // public xAI media API. Chat remains on cli-chat-proxy above.
    image: {
      protocol: 'grok-imagine-image',
      baseUrl: 'https://api.x.ai/v1',
      models: ['grok-imagine-image-quality', 'grok-imagine-image']
    },
    video: {
      protocol: 'grok-imagine-video',
      baseUrl: 'https://api.x.ai/v1',
      models: ['grok-imagine-video-1.5-preview', 'grok-imagine-video']
    },
    speech: {
      protocol: 'xai-stt',
      baseUrl: 'https://api.x.ai/v1',
      models: ['grok-transcribe']
    },
    docsUrl: 'https://docs.x.ai/',
    apiKeyUrl: 'https://accounts.x.ai'
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    endpointFormat: 'chat_completions',
    models: [],
    docsUrl: 'https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions',
    apiKeyUrl: 'https://vercel.com/ai-gateway'
  }
]

export function getModelProviderPreset(id: string): ModelProviderPreset | null {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null
}

function defaultPresetRetrySettings() {
  return {
    maxAttempts: DEFAULT_MODEL_REQUEST_RETRY_MAX_ATTEMPTS,
    initialDelayMs: DEFAULT_MODEL_REQUEST_RETRY_INITIAL_DELAY_MS,
    httpStatusCodes: [...DEFAULT_MODEL_REQUEST_RETRY_HTTP_STATUS_CODES]
  }
}

export function modelProviderPresetProfile(
  preset: ModelProviderPreset,
  apiKey = ''
): ModelProviderProfileV1 {
  return {
    id: preset.id,
    name: preset.name,
    presetSource: { presetId: preset.id, mode: 'api' },
    apiKey: apiKey.trim(),
    baseUrl: preset.baseUrl,
    endpointFormat: preset.endpointFormat,
    retry: preset.kind === 'gemini-cli-api'
      ? {
          ...defaultPresetRetrySettings(),
          // The official Gemini CLI retries transient Code Assist capacity and
          // server failures. Preserve that behavior for multi-step tool turns.
          maxAttempts: 3
        }
      : defaultPresetRetrySettings(),
    ...(preset.kind ? { kind: preset.kind } : {}),
    models: [...preset.models],
    modelProfiles: copyModelProfiles(preset.modelProfiles),
    ...(preset.image ? { image: modelProviderPresetImageCapability(preset.image) } : {}),
    ...(preset.speech ? { speech: modelProviderPresetSpeechCapability(preset.speech) } : {}),
    ...(preset.textToSpeech
      ? { textToSpeech: modelProviderPresetTextToSpeechCapability(preset.textToSpeech) }
      : {}),
    ...(preset.music ? { music: modelProviderPresetMusicCapability(preset.music) } : {}),
    ...(preset.video ? { video: modelProviderPresetVideoCapability(preset.video) } : {})
  }
}

export function tokenPlanProviderId(presetId: string): string {
  return `${presetId}${TOKEN_PLAN_PROVIDER_ID_SUFFIX}`
}

export function modelProviderTokenPlanProfile(
  preset: ModelProviderPreset,
  apiKey = '',
  baseUrl = ''
): ModelProviderProfileV1 | null {
  const tokenPlan = preset.tokenPlan
  if (!tokenPlan) return null
  const resolvedBaseUrl = baseUrl.trim() || tokenPlan.baseUrl
  return {
    id: tokenPlanProviderId(preset.id),
    name: `${preset.name} Token Plan`,
    presetSource: { presetId: preset.id, mode: 'token-plan' },
    apiKey: apiKey.trim(),
    baseUrl: resolvedBaseUrl,
    endpointFormat: tokenPlan.endpointFormat,
    retry: defaultPresetRetrySettings(),
    models: [...tokenPlan.models],
    modelProfiles: copyModelProfiles(tokenPlan.modelProfiles),
    ...(tokenPlan.image
      ? {
          image: {
            protocol: tokenPlan.image.protocol,
            baseUrl: tokenPlanCapabilityBaseUrl(tokenPlan, resolvedBaseUrl, tokenPlan.image.baseUrl),
            models: [...tokenPlan.image.models]
          }
        }
      : {}),
    ...(tokenPlan.speech
      ? {
          speech: {
            protocol: tokenPlan.speech.protocol,
            baseUrl: resolvedBaseUrl,
            models: [...tokenPlan.speech.models]
          }
        }
      : {}),
    ...(tokenPlan.textToSpeech
      ? {
          textToSpeech: {
            protocol: tokenPlan.textToSpeech.protocol,
            baseUrl: tokenPlanCapabilityBaseUrl(tokenPlan, resolvedBaseUrl, tokenPlan.textToSpeech.baseUrl),
            models: [...tokenPlan.textToSpeech.models]
          }
        }
      : {}),
    ...(tokenPlan.music
      ? {
          music: {
            protocol: tokenPlan.music.protocol,
            baseUrl: tokenPlanCapabilityBaseUrl(tokenPlan, resolvedBaseUrl, tokenPlan.music.baseUrl),
            models: [...tokenPlan.music.models]
          }
        }
      : {}),
    ...(tokenPlan.video
      ? {
          video: {
            protocol: tokenPlan.video.protocol,
            baseUrl: tokenPlanCapabilityBaseUrl(tokenPlan, resolvedBaseUrl, tokenPlan.video.baseUrl),
            models: [...tokenPlan.video.models]
          }
        }
      : {})
  }
}

export type ResolvedModelProviderPresetSource = {
  preset: ModelProviderPreset
  mode: ModelProviderPresetMode
}

/**
 * Resolves a persisted profile back to its built-in preset. Explicit source
 * metadata supports multi-account ids; exact legacy ids remain compatible.
 */
export function resolveModelProviderPresetSource(
  profile: Pick<ModelProviderProfileV1, 'id' | 'presetSource'>
): ResolvedModelProviderPresetSource | null {
  const explicit = profile.presetSource
  if (explicit) {
    const preset = getModelProviderPreset(explicit.presetId)
    if (!preset || (explicit.mode === 'token-plan' && !preset.tokenPlan)) return null
    return { preset, mode: explicit.mode }
  }
  const direct = getModelProviderPreset(profile.id)
  if (direct) return { preset: direct, mode: 'api' }
  if (!profile.id.endsWith(TOKEN_PLAN_PROVIDER_ID_SUFFIX)) return null
  const preset = getModelProviderPreset(profile.id.slice(0, -TOKEN_PLAN_PROVIDER_ID_SUFFIX.length))
  return preset?.tokenPlan ? { preset, mode: 'token-plan' } : null
}

export function isMultiAccountProviderPreset(
  preset: ModelProviderPreset,
  mode: ModelProviderPresetMode
): boolean {
  return mode === 'token-plan' || preset.category === 'subscription'
}

export function modelProviderPresetAccountCount(
  preset: ModelProviderPreset,
  mode: ModelProviderPresetMode,
  providers: readonly Pick<ModelProviderProfileV1, 'id' | 'name' | 'presetSource'>[]
): number {
  return providers.filter((provider) => {
    const source = resolveModelProviderPresetSource(provider)
    return source?.preset.id === preset.id && source.mode === mode
  }).length
}

/** Builds the next independent account profile for a preset/mode family. */
export function modelProviderPresetAccountProfile(
  preset: ModelProviderPreset,
  mode: ModelProviderPresetMode,
  providers: readonly Pick<ModelProviderProfileV1, 'id' | 'name' | 'presetSource'>[]
): ModelProviderProfileV1 | null {
  const base = mode === 'token-plan'
    ? modelProviderTokenPlanProfile(preset)
    : modelProviderPresetProfile(preset)
  if (!base) return null
  const family = providers.filter((provider) => {
    const source = resolveModelProviderPresetSource(provider)
    return source?.preset.id === preset.id && source.mode === mode
  })
  const idPattern = new RegExp(`^${escapeRegExp(base.id)}-(\\d+)$`)
  const namePattern = new RegExp(`^${escapeRegExp(base.name)} (\\d+)$`, 'i')
  let highestOrdinal = 0
  for (const provider of family) {
    highestOrdinal = Math.max(
      highestOrdinal,
      provider.id === base.id ? 1 : Number(idPattern.exec(provider.id)?.[1] ?? 0),
      provider.name.toLowerCase() === base.name.toLowerCase() ? 1 : Number(namePattern.exec(provider.name)?.[1] ?? 0)
    )
  }
  let ordinal = family.length === 0 ? 1 : Math.max(highestOrdinal, family.length) + 1
  const usedIds = new Set(providers.map((provider) => provider.id.toLowerCase()))
  const usedNames = new Set(providers.map((provider) => provider.name.trim().toLowerCase()).filter(Boolean))
  while (true) {
    const id = ordinal === 1 ? base.id : `${base.id}-${ordinal}`
    const name = ordinal === 1 ? base.name : `${base.name} ${ordinal}`
    if (!usedIds.has(id.toLowerCase()) && !usedNames.has(name.toLowerCase())) {
      return { ...base, id, name }
    }
    ordinal += 1
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tokenPlanCapabilityBaseUrl(
  tokenPlan: ModelProviderTokenPlanPreset,
  resolvedBaseUrl: string,
  capabilityBaseUrl: string | undefined
): string {
  const fallback = capabilityBaseUrl?.trim() || resolvedBaseUrl
  if (!capabilityBaseUrl?.trim()) return resolvedBaseUrl
  const resolvedOrigin = urlOrigin(resolvedBaseUrl)
  const capabilityOrigin = urlOrigin(capabilityBaseUrl)
  if (!resolvedOrigin || !capabilityOrigin) return fallback
  const planOrigins = [
    tokenPlan.baseUrl,
    ...(tokenPlan.regions?.map((region) => region.baseUrl) ?? [])
  ].map(urlOrigin).filter((origin): origin is string => Boolean(origin))
  if (!planOrigins.includes(capabilityOrigin)) return fallback
  return replaceUrlOrigin(capabilityBaseUrl, resolvedOrigin)
}

function urlOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null
  try {
    return new URL(value.trim()).origin
  } catch {
    return null
  }
}

function replaceUrlOrigin(value: string, origin: string): string {
  try {
    const url = new URL(value.trim())
    const path = url.pathname.replace(/\/+$/, '')
    return `${origin}${path === '/' ? '' : path}${url.search}`
  } catch {
    return value.trim()
  }
}

function xiaomiTextChatProfile(contextWindowTokens: number): ModelProviderModelProfileV1 {
  return textChatProfile(contextWindowTokens, XIAOMI_REASONING)
}

function xiaomiVisionChatProfile(contextWindowTokens: number): ModelProviderModelProfileV1 {
  return visionChatProfile(contextWindowTokens, XIAOMI_REASONING)
}

function minimaxM3ChatProfile(): ModelProviderModelProfileV1 {
  return visionChatProfile(1_000_000, MINIMAX_M3_REASONING)
}

function minimaxM2ChatProfile(): ModelProviderModelProfileV1 {
  return textChatProfile(204_800, MINIMAX_BUILT_IN_REASONING)
}

function textChatProfile(
  contextWindowTokens?: number,
  reasoning?: ModelProviderReasoningCapabilityV1,
  endpointFormat?: ModelEndpointFormat
): ModelProviderModelProfileV1 {
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text'],
    ...(reasoning ? { reasoning } : {}),
    ...(endpointFormat ? { endpointFormat } : {})
  }
}

function visionChatProfile(
  contextWindowTokens?: number,
  reasoning?: ModelProviderReasoningCapabilityV1,
  endpointFormat?: ModelEndpointFormat
): ModelProviderModelProfileV1 {
  return {
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text', 'image_url'],
    ...(reasoning ? { reasoning } : {}),
    ...(endpointFormat ? { endpointFormat } : {})
  }
}

function codexLiteVisionChatProfile(contextWindowTokens: number): ModelProviderModelProfileV1 {
  return {
    ...visionChatProfile(contextWindowTokens),
    responsesMode: 'lite'
  }
}

function copyModelProfiles(
  profiles: Record<string, ModelProviderModelProfileV1> | undefined
): Record<string, ModelProviderModelProfileV1> {
  if (!profiles) return {}
  return Object.fromEntries(
    Object.entries(profiles).map(([modelId, profile]) => [
      modelId,
      {
        ...profile,
        ...(profile.aliases ? { aliases: [...profile.aliases] } : {}),
        inputModalities: [...profile.inputModalities],
        outputModalities: [...profile.outputModalities],
        messageParts: [...profile.messageParts],
        ...(profile.reasoning
          ? {
              reasoning: {
                supportedEfforts: [...profile.reasoning.supportedEfforts],
                defaultEffort: profile.reasoning.defaultEffort,
                requestProtocol: profile.reasoning.requestProtocol
              }
            }
          : {})
      }
    ])
  )
}

function modelProviderPresetImageCapability(
  image: NonNullable<ModelProviderPreset['image']>
): ModelProviderImageCapabilityV1 {
  return {
    protocol: image.protocol,
    baseUrl: image.baseUrl,
    models: [...image.models]
  }
}

function modelProviderPresetSpeechCapability(
  speech: NonNullable<ModelProviderPreset['speech']>
): ModelProviderSpeechCapabilityV1 {
  return {
    protocol: speech.protocol,
    baseUrl: speech.baseUrl,
    models: [...speech.models]
  }
}

function modelProviderPresetTextToSpeechCapability(
  textToSpeech: NonNullable<ModelProviderPreset['textToSpeech']>
): ModelProviderTextToSpeechCapabilityV1 {
  return {
    protocol: textToSpeech.protocol,
    baseUrl: textToSpeech.baseUrl,
    models: [...textToSpeech.models]
  }
}

function modelProviderPresetMusicCapability(
  music: NonNullable<ModelProviderPreset['music'] | ModelProviderTokenPlanPreset['music']>
): ModelProviderMusicCapabilityV1 {
  return {
    protocol: music.protocol,
    baseUrl: music.baseUrl,
    models: [...music.models]
  }
}

function modelProviderPresetVideoCapability(
  video: NonNullable<ModelProviderPreset['video'] | ModelProviderTokenPlanPreset['video']>
): ModelProviderVideoCapabilityV1 {
  return {
    protocol: video.protocol,
    baseUrl: video.baseUrl,
    models: [...video.models]
  }
}
