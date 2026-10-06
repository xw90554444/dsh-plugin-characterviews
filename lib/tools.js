/**
 * Agent-facing tools.
 *
 * These call the same `api` object the panel UI reaches over the web route, so a
 * picture produced by the agent and one produced by the panel are the same asset with
 * the same index entry. Nothing here re-implements a capability.
 *
 * Shape matters more than it looks. `ctx.tools.register()` rejects a definition that
 * does not use `execute` and does not declare `output: { schema, render }` — and the
 * failure is not contained to the tool: registration throws, and a throw during plugin
 * load takes the whole plugin down, panel included. That is why each definition carries
 * its `output`, and why `index.js` registers them one `ctx.effect` at a time.
 */

/** Tool results are text blocks, not strings: the harness wants the structured form. */
const text = (value) => [{ type: 'text', text: String(value) }]

/**
 * Schema for what a tool hands back.
 *
 * Deliberately loose. The harness validates `execute`'s return against this, so a
 * tight schema turns a working tool into a hard error at call time — and the payloads
 * here are genuinely varied (a status report, an asset list, a run record).
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '工具是否成功完成' },
    error: { type: 'object', additionalProperties: true, description: '失败时的 { code, message }' },
  },
  additionalProperties: true,
  description: '工具的原始返回对象；除 ok 外的字段随工具而异。',
}

/** Wrap a definition so every tool declares the `output` the harness requires. */
function withOutput(definition, schema = OUTPUT_SCHEMA) {
  const { render, output, ...rest } = definition
  return { ...rest, output: output ?? { schema, render } }
}

/** The failure line, when the payload is a failure. Null when it is not. */
function failure(value) {
  if (value && value.ok === false) {
    return `错误 [${value.error?.code ?? 'unknown'}]：${value.error?.message ?? '未知失败'}`
  }
  return null
}

/** Readable one-liner for an asset, used by several renders. */
function assetLine(asset) {
  const mb = (Number(asset.bytes) || 0) / 1024 / 1024
  return `- ${asset.label}　${mb.toFixed(1)}MB　id=${asset.id}`
}

export function createToolsPlugin(api) {
  const definitions = [
    withOutput({
      name: 'characterviews_status',
      description: [
        '检查角色多视图插件是否可用：本地 ComfyUI 连接、模型是否齐全、显存够不够、图片存在哪里。',
        '出图前先调它，能提前发现"连不上""缺模型"这类问题。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: { fresh: { type: 'boolean', description: '为 true 时绕过模型列表缓存重新读取' } },
        additionalProperties: false,
      },
      async execute(args) {
        const status = await api.status({ fresh: args?.fresh === true })
        return {
          ok: status.ok,
          version: status.comfy?.version ?? null,
          baseUrl: status.comfy?.baseUrl ?? null,
          models: status.comfy?.models ?? null,
          missingNodes: status.comfy?.nodes?.missing ?? [],
          capacity: status.capacity ?? null,
          paths: status.paths,
          problems: status.problems ?? [],
        }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        const lines = [
          value.ok ? '环境就绪。' : `环境有问题，共 ${value.problems.length} 条：`,
          ...(value.problems ?? []).map((p) => `- ${p}`),
          `ComfyUI ${value.version ?? '?'}　${value.baseUrl ?? ''}`,
          `扩散模型：${value.models?.diffusionModel ?? '未找到'}`,
          `文本编码器：${value.models?.textEncoder ?? '未找到'}`,
          `VAE：${value.models?.vae ?? '未找到'}`,
          value.capacity?.vramFreeBytes
            ? `可用显存 ${(value.capacity.vramFreeBytes / 1024 ** 3).toFixed(1)}GB（${value.capacity.level}）`
            : '',
          `图片目录：${value.paths?.characters ?? '?'}`,
        ].filter(Boolean)
        return text(lines.join('\n'))
      },
    }),

    withOutput({
      name: 'characterviews_list',
      description: '列出所有角色，以及每个角色已有的照片数和出图数。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { ok: true, characters: await api.listCharacters() }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        if (value.characters.length === 0) return text('还没有任何角色。用 characterviews_create_character 建一个。')
        return text(value.characters
          .map((c) => `- ${c.name}　id=${c.id}　照片 ${c.photoCount} 张　出图 ${c.viewCount} 张`)
          .join('\n'))
      },
    }),

    withOutput({
      name: 'characterviews_create_character',
      description: '新建一个角色。角色是照片与出图的容器，图片会存到 <DSH_HOME>/characterviews/characters/<角色名>/。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '角色名，会用作文件夹名' },
          notes: { type: 'string', description: '备注，例如服装、道具、设定' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async execute(args) {
        const character = await api.createCharacter({ name: args?.name, notes: args?.notes })
        return { ok: Boolean(character), character }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        if (!value.character) return text('新建失败。')
        return text(`已创建「${value.character.name}」　id=${value.character.id}\n目录：${value.character.dir}`)
      },
    }),

    withOutput({
      name: 'characterviews_upload_photo',
      description: [
        '把一张本地照片作为角色的参考图导入。照片是出图的身份依据，正面、清晰、全身的效果最好。',
        '照片会原样保存（不重新压缩），同时上传给 ComfyUI 的 input 目录。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '角色 id' },
          path: { type: 'string', description: '照片的本地绝对路径（png/jpg/webp/bmp）' },
        },
        required: ['characterId', 'path'],
        additionalProperties: false,
      },
      async execute(args) {
        const { readFile } = await import('node:fs/promises')
        const { extname, basename, resolve } = await import('node:path')
        const path = String(args?.path ?? '')
        const ext = extname(path).replace('.', '').toLowerCase()
        if (!['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
          return { ok: false, error: { code: 'bad-format', message: `不支持的图片格式 .${ext}，请用 png/jpg/webp/bmp` } }
        }
        let bytes
        try {
          bytes = await readFile(resolve(path))
        } catch (error) {
          return { ok: false, error: { code: 'unreadable', message: `读不到这个文件：${String(error?.message ?? error)}` } }
        }
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
        const result = await api.uploadPhoto({
          characterId: args?.characterId,
          filename: basename(path),
          dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
        })
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, assetId: result.asset.id, bytes: result.asset.bytes, comfyName: result.comfyName, warning: result.warning }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        return text([
          `已导入照片 ${value.assetId}（${(value.bytes / 1024).toFixed(0)}KB）`,
          `ComfyUI 里的文件名：${value.comfyName ?? '（未上传成功）'}`,
          value.warning ? `注意：${value.warning}` : '',
        ].filter(Boolean).join('\n'))
      },
    }),

    withOutput({
      name: 'characterviews_render',
      description: [
        '按角色照片出多视图。mode：single（单视图，用 yaw/pitch 指定角度）、three（三视图：正面+侧面+背面）、',
        'multi（五视图：正面+侧面+背面+仰视45°+俯视45°）、custom（用 views 指定最多 8 个角度）。',
        'layout：sheet（默认，把所有角度画进一张设定图，一致性最好）、separate（每个角度单独一张，分辨率更高）。',
        '立刻返回 runId，用 characterviews_run 查进度；单张图通常 1-3 分钟。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '角色 id' },
          mode: { type: 'string', enum: ['single', 'three', 'multi', 'custom'], description: '视图模式' },
          layout: { type: 'string', enum: ['sheet', 'separate'], description: '一张设定图 / 每角度一张' },
          yaw: { type: 'number', description: 'mode=single 时的水平角：0 正面、90 右侧、180 背面、270 左侧' },
          pitch: { type: 'number', description: 'mode=single 时的俯仰角：正数俯视、负数仰视，例如 -45 是仰视 45°' },
          views: {
            type: 'array',
            items: { type: 'string' },
            description: 'mode=custom 时的角度键：front、frontLeft34、left、backLeft34、back、backRight34、right、frontRight34、low45、high45、low30、high30、topDown',
          },
          seed: { type: 'number', description: '固定种子，方便复现；不填则随机' },
          count: { type: 'number', description: '出几张变体，默认 1，最多 4' },
          notes: { type: 'string', description: '额外要求，例如「保持这件深灰色圆领 T 恤」「背景换成纯白」' },
        },
        required: ['characterId', 'mode'],
        additionalProperties: false,
      },
      async execute(args) {
        const result = await api.startRender(args ?? {})
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, runId: result.runId, batchId: result.batchId, plan: result.plan }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        const p = value.plan
        return text([
          `已开始出图：runId=${value.runId}`,
          `角度：${p.viewLabels.join(' / ')}`,
          `方式：${p.layout === 'sheet' ? '一张设定图' : '每角度一张'}　共 ${p.jobs} 个任务 × ${p.count} 张`,
          `画布 ${p.canvas?.width}×${p.canvas?.height}　${p.steps} 步　种子 ${p.seed}`,
          '用 characterviews_run 查进度。',
        ].join('\n'))
      },
    }),

    withOutput({
      name: 'characterviews_run',
      description: '查看一次出图任务的进度或结果。status=running/queued 时看 phase 与 message；done 时 result.assets 里是图片列表。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string', description: 'characterviews_render 返回的 runId' } },
        required: ['runId'],
        additionalProperties: false,
      },
      async execute(args) {
        const run = api.runStatus(args?.runId)
        if (!run) return { ok: false, error: { code: 'not-found', message: `没有这次运行「${args?.runId}」` } }
        return { ok: true, run }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        const run = value.run
        const lines = [
          `状态：${run.status}／${run.phase}　已用 ${Math.round(run.elapsedMs / 1000)}s`,
          run.total ? `进度：${run.current}/${run.total}` : '',
          run.message ? `说明：${run.message}` : '',
          run.error ? `错误 [${run.error.code}]：${run.error.message}` : '',
        ].filter(Boolean)
        if (run.result) {
          lines.push(`产出 ${run.result.assets.length} 张：`)
          lines.push(...run.result.assets.map(assetLine))
          lines.push(`目录：${run.result.charactersDir}`)
        }
        return text(lines.join('\n'))
      },
    }),

    withOutput({
      name: 'characterviews_cancel',
      description: '取消一次正在跑的出图任务，并把它从 ComfyUI 的队列里撤掉（不会留下空转的 GPU 任务）。',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string', description: '要取消的 runId' } },
        required: ['runId'],
        additionalProperties: false,
      },
      async execute(args) {
        return api.cancelRun(args?.runId)
      },
      render(_args, value) {
        if (value?.ok === false) return text(failure(value) ?? '取消失败。')
        const stopped = value?.stoppedPrompts ?? []
        return text(stopped.length > 0
          ? `已取消，并撤掉了 ComfyUI 队列里的 ${stopped.length} 个任务。`
          : '已取消（这个任务还没有提交到 ComfyUI）。')
      },
    }),

    withOutput({
      name: 'characterviews_reveal',
      description: '在系统文件管理器里打开某张图所在的位置，并在文件夹里选中它。不给 assetId 就打开这个角色的目录。',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '角色 id' },
          assetId: { type: 'string', description: '可选：要选中的那张图' },
        },
        required: ['characterId'],
        additionalProperties: false,
      },
      async execute(args) {
        return api.reveal(args ?? {})
      },
      render(_args, value) {
        if (value?.ok === false) return text(failure(value) ?? '打不开。')
        return text(`已在文件管理器中打开：${value.opened}`)
      },
    }),

    withOutput({
      name: 'characterviews_trash',
      description: [
        '回收站：列出、恢复、彻底删除、清空。',
        '删照片时它不会从磁盘上消失，而是先进回收站——照片是唯一不能再生成的东西，',
        '而生成的图是可重出的（种子和提示词都记在批次里），所以生成图是直接删。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'restore', 'purge', 'empty'], description: '要执行的操作' },
          entryId: { type: 'string', description: 'restore / purge 需要的回收站条目 id' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args) {
        const action = String(args?.action ?? 'list')
        if (action === 'list') {
          const listed = await api.listTrash()
          return { ok: true, entries: listed.entries, totalBytes: listed.totalBytes, dir: listed.dir }
        }
        if (action === 'restore') {
          const result = await api.restoreTrash(args?.entryId)
          return result.ok ? { ok: true, restored: result.restored } : { ok: false, error: result.error }
        }
        if (action === 'purge') {
          const result = await api.deleteTrashEntry(args?.entryId)
          return result.ok ? { ok: true } : { ok: false, error: result.error }
        }
        if (action === 'empty') {
          const result = await api.emptyTrash()
          return { ok: true, removed: result.removed, freedBytes: result.freedBytes }
        }
        return { ok: false, error: { code: 'bad-action', message: `不认识的操作 ${action}` } }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        if (value.entries) {
          if (value.entries.length === 0) return text(`回收站是空的。目录：${value.dir ?? '?'}`)
          return text([
            `回收站 ${value.entries.length} 项，共 ${(value.totalBytes / 1024 / 1024).toFixed(1)}MB　目录：${value.dir}`,
            ...value.entries.map((e) => `- ${e.originalName ?? e.fileName}　原属「${e.characterName}」　${new Date(e.deletedAt).toLocaleString()}　id=${e.id}`),
          ].join('\n'))
        }
        if (value.restored) return text(`已恢复到：${value.restored.path}`)
        if (value.freedBytes !== undefined) {
          return text(`回收站已清空：删掉 ${value.removed} 项，释放 ${(value.freedBytes / 1024 / 1024).toFixed(1)}MB。`)
        }
        return text('已彻底删除。')
      },
    }),

    withOutput({
      name: 'characterviews_get',
      description: '读取一个角色的完整资料：照片、已出的图、每一批出图用的角度与种子、以及本地目录。',
      parameters: {
        type: 'object',
        properties: { characterId: { type: 'string', description: '角色 id' } },
        required: ['characterId'],
        additionalProperties: false,
      },
      async execute(args) {
        const character = await api.getCharacter(args?.characterId)
        if (!character) return { ok: false, error: { code: 'not-found', message: `没有这个角色「${args?.characterId}」` } }
        return { ok: true, character }
      },
      render(_args, value) {
        const bad = failure(value)
        if (bad) return text(bad)
        const c = value.character
        const photos = c.assets.filter((a) => a.kind === 'photo')
        const views = c.assets.filter((a) => a.kind === 'view')
        const lines = [
          `${c.name}　id=${c.id}`,
          `目录：${c.dir}`,
          c.notes ? `备注：${c.notes}` : '',
          `照片 ${photos.length} 张：`,
          ...photos.map((p) => `- ${p.label}　id=${p.id}`),
          `出图 ${views.length} 张：`,
          ...views.map(assetLine),
        ].filter(Boolean)
        if (c.batches.length > 0) {
          lines.push(`出图记录 ${c.batches.length} 批：`)
          lines.push(...c.batches.slice(0, 5).map((b) => (
            `- ${b.mode}／${b.viewLabels.join('+')}　种子 ${b.seed}　${b.canvas?.width}×${b.canvas?.height}　${b.assetIds.length} 张`
          )))
        }
        return text(lines.join('\n'))
      },
    }),
  ]

  return {
    name: 'characterViewsTools',
    /** Exposed so the host can register each definition in isolation. */
    definitions,
    apply(ctx) {
      // One effect per tool, mirroring the sibling plugins: a definition the harness
      // rejects then fails alone instead of taking the panel down with it.
      for (const definition of definitions) {
        ctx.effect(() => ctx.tools.register(definition), `characterviews.tool.${definition.name}`)
      }
    },
  }
}

export default createToolsPlugin
