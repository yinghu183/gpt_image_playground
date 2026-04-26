import type { AppSettings, ImageApiResponse, TaskParams } from '../types'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export { normalizeBaseUrl } from './devProxy'

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  return blobToDataUrl(await response.blob(), fallbackMime)
}

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
}

interface ResponsesImageGenerationItem {
  type?: string
  result?: string
  revised_prompt?: string
}

interface ResponsesApiResponse {
  output?: ResponsesImageGenerationItem[]
}

async function parseErrorResponse(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await response.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

async function createImageEditRequest(
  settings: AppSettings,
  prompt: string,
  params: TaskParams,
  inputImageDataUrls: string[],
  requestHeaders: Record<string, string>,
  controller: AbortController,
  proxyConfig: ReturnType<typeof readClientDevProxyConfig>,
): Promise<Response> {
  const formData = new FormData()
  formData.append('model', settings.model)
  formData.append('prompt', prompt)
  formData.append('size', params.size)
  formData.append('quality', params.quality)
  formData.append('output_format', params.output_format)
  formData.append('moderation', params.moderation)

  if (params.output_format !== 'png' && params.output_compression != null) {
    formData.append('output_compression', String(params.output_compression))
  }

  for (let i = 0; i < inputImageDataUrls.length; i++) {
    const dataUrl = inputImageDataUrls[i]
    const resp = await fetch(dataUrl)
    const blob = await resp.blob()
    const ext = blob.type.split('/')[1] || 'png'
    formData.append('image[]', blob, `input-${i + 1}.${ext}`)
  }

  return fetch(buildApiUrl(settings.baseUrl, 'images/edits', proxyConfig), {
    method: 'POST',
    headers: requestHeaders,
    cache: 'no-store',
    body: formData,
    signal: controller.signal,
  })
}

async function createImageGenerationRequest(
  settings: AppSettings,
  prompt: string,
  params: TaskParams,
  requestHeaders: Record<string, string>,
  controller: AbortController,
  proxyConfig: ReturnType<typeof readClientDevProxyConfig>,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: settings.model,
    prompt,
    size: params.size,
    quality: params.quality,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    body.output_compression = params.output_compression
  }
  if (params.n > 1) {
    body.n = params.n
  }

  return fetch(buildApiUrl(settings.baseUrl, 'images/generations', proxyConfig), {
    method: 'POST',
    headers: {
      ...requestHeaders,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
    signal: controller.signal,
  })
}

async function createResponsesGenerationRequest(
  settings: AppSettings,
  prompt: string,
  params: TaskParams,
  inputImageDataUrls: string[],
  requestHeaders: Record<string, string>,
  controller: AbortController,
  proxyConfig: ReturnType<typeof readClientDevProxyConfig>,
): Promise<Response> {
  const content: Array<Record<string, unknown>> = []

  if (prompt.trim()) {
    content.push({ type: 'input_text', text: prompt })
  }

  for (const dataUrl of inputImageDataUrls) {
    content.push({
      type: 'input_image',
      image_url: dataUrl,
    })
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    input: [
      {
        role: 'user',
        content,
      },
    ],
    tools: [
      {
        type: 'image_generation',
        size: params.size,
        quality: params.quality,
        format: params.output_format,
        moderation: params.moderation,
        ...(params.output_format !== 'png' && params.output_compression != null
          ? { output_compression: params.output_compression }
          : {}),
        ...(inputImageDataUrls.length > 0 ? { action: 'auto' } : { action: 'generate' }),
      },
    ],
  }

  return fetch(buildApiUrl(settings.baseUrl, 'responses', proxyConfig), {
    method: 'POST',
    headers: {
      ...requestHeaders,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
    signal: controller.signal,
  })
}

async function parseImagesApiResponse(response: Response, mime: string, signal: AbortSignal): Promise<string[]> {
  const payload = await response.json() as ImageApiResponse
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    throw new Error('接口未返回图片数据')
  }

  const images: string[] = []
  for (const item of data) {
    const b64 = item.b64_json
    if (b64) {
      images.push(normalizeBase64Image(b64, mime))
      continue
    }

    if (isHttpUrl(item.url)) {
      images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
    }
  }

  return images
}

async function parseResponsesApiResponse(response: Response, mime: string): Promise<string[]> {
  const payload = await response.json() as ResponsesApiResponse
  const outputs = Array.isArray(payload.output) ? payload.output : []

  const images = outputs
    .filter((item) => item.type === 'image_generation_call' && typeof item.result === 'string' && item.result)
    .map((item) => normalizeBase64Image(item.result as string, mime))

  return images
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = {
    Authorization: `Bearer ${settings.apiKey}`,
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    let response: Response

    if (settings.apiMode === 'responses') {
      response = await createResponsesGenerationRequest(
        settings,
        prompt,
        params,
        inputImageDataUrls,
        requestHeaders,
        controller,
        proxyConfig,
      )
    } else if (isEdit) {
      response = await createImageEditRequest(
        settings,
        prompt,
        params,
        inputImageDataUrls,
        requestHeaders,
        controller,
        proxyConfig,
      )
    } else {
      response = await createImageGenerationRequest(
        settings,
        prompt,
        params,
        requestHeaders,
        controller,
        proxyConfig,
      )
    }

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response))
    }

    const images = settings.apiMode === 'responses'
      ? await parseResponsesApiResponse(response, mime)
      : await parseImagesApiResponse(response, mime, controller.signal)

    if (!images.length) {
      throw new Error('接口未返回可用图片数据')
    }

    return { images }
  } finally {
    clearTimeout(timeoutId)
  }
}
