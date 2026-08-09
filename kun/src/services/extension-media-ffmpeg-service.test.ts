import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionPrincipal } from './extension-agent-service.js'
import { ExtensionMediaHandleService } from './extension-media-handle-service.js'
import {
  EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
  EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
  ExtensionMediaProcessService,
  runBoundedProcess
} from './extension-media-process-service.js'
import {
  ExtensionMediaFfmpegService,
  validateAndSubstituteFfmpegArguments
} from './extension-media-ffmpeg-service.js'

const roots: string[] = []

const MEDIA_PROCESS_TEST_TIMEOUT_MS = 15_000

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kun-media-ffmpeg-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const bin = join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  await mkdir(join(workspace, 'exports'), { recursive: true })
  await writeFile(join(workspace, 'clip.mp4'), Buffer.from('source-video'))
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.includes('-version')) {
  process.stdout.write('ffmpeg version 7.1-test\\n')
  process.exit(0)
}
const target = process.argv.at(-1)
fs.writeFileSync(target, Buffer.from('rendered-video'))
process.stdout.write('frame=12\\nout_time_us=1250000\\ntotal_size=14\\nspeed=2.5x\\nprogress=end\\n')
`)
  if (process.platform !== 'win32') await chmod(bin, 0o755)
  const principal: ExtensionPrincipal = {
    extensionId: 'acme.video',
    extensionVersion: '1.0.0',
    permissions: [
      'media.read',
      'media.process',
      'media.export',
      'workspace.read',
      'workspace.write'
    ],
    workspaceRoots: [workspace],
    workspaceTrusted: true
  }
  const handles = new ExtensionMediaHandleService({ dataDir })
  const input = await handles.register(principal, {
    workspaceRoot: workspace,
    path: 'clip.mp4',
    mode: 'read',
    source: 'workspace'
  })
  const output = await handles.register(principal, {
    workspaceRoot: workspace,
    path: 'exports/final.mp4',
    mode: 'write',
    source: 'workspace'
  })
  const processes = new ExtensionMediaProcessService({
    handleService: handles,
    ffmpegPath: bin,
    pathEnv: process.env.PATH,
    processRunner: (_executable, args, options) =>
      runBoundedProcess(process.execPath, [bin, ...args], options)
  })
  const ffmpeg = new ExtensionMediaFfmpegService({ handleService: handles, processService: processes })
  return {
    root,
    workspace,
    dataDir,
    bin,
    principal,
    handles,
    input,
    output,
    ffmpeg,
    processRunner: (_executable: string, args: string[], options: Parameters<typeof runBoundedProcess>[2]) =>
      runBoundedProcess(process.execPath, [bin, ...args], options)
  }
}

describe('validateAndSubstituteFfmpegArguments', () => {
  it('substitutes only exact declared resource placeholders', () => {
      expect(validateAndSubstituteFfmpegArguments(
        [
          '-ss', '0.125000', '-i', '{{input:source}}',
          '-c:v', 'libx264', '-r', '30000/1001', '{{output:video}}'
        ],
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).toEqual([
        '-ss', '0.125000',
        '-protocol_whitelist', EXTENSION_MEDIA_INPUT_PROTOCOL_WHITELIST,
        '-format_whitelist', EXTENSION_MEDIA_INPUT_FORMAT_WHITELIST,
        '-i', '/host/source.mp4',
        '-c:v', 'libx264', '-r', '30000/1001', '/host/.staging.mp4'
      ])
    })

  it('accepts reviewed inline drawtext while rejecting file-backed options', () => {
      expect(() => validateAndSubstituteFfmpegArguments(
        [
          '-i', '{{input:source}}',
          '-vf', "drawtext=text=Hello\\\\: % $ ` {{ fontfile=/etc/passwd:font=Kun Sans:expansion=none:fontsize=32:x=10:y=20",
          '{{output:video}}'
        ],
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).not.toThrow()
      expect(() => validateAndSubstituteFfmpegArguments(
        [
          '-i', '{{input:source}}',
          '-vf', 'drawtext=text=Hello:expansion=none:fontfile=/etc/passwd',
          '{{output:video}}'
        ],
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).toThrow()
      expect(() => validateAndSubstituteFfmpegArguments(
        [
          '-i', '{{input:source}}',
          '-vf', 'drawtext=text=Hello:font=../Kun Sans:expansion=none',
          '{{output:video}}'
        ],
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).toThrow()
      expect(() => validateAndSubstituteFfmpegArguments(
        [
          '-i', '{{input:source}}',
          '-vf', 'drawtext=textfile=/etc/passwd:expansion=none',
          '{{output:video}}'
        ],
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).toThrow()
    })

  it('accepts the reviewed composed-video filter chain used by the editor', () => {
      const graph = [
        'color=c=#000000:s=1920x1080:r=30000/1001:d=1.500000[base]',
        '[0:v]setpts=(PTS-STARTPTS)/1*1,scale=1920:1080:force_original_aspect_ratio=decrease,' +
          'format=rgba,colorchannelmixer=aa=1.0000,setpts=PTS+0.000000/TB[vprep0]',
        "[base][vprep0]overlay=x='(W-w)/2':y='(H-h)/2':eof_action=pass:" +
          "enable='between(t,0.000000,1.500000)'[vcomp0]",
        "[vcomp0]drawtext=text=Hello\\\\: % $ `:expansion=none:fontcolor=0xFFFFFF:" +
          "font=sans-serif:fontsize=48:box=1:boxcolor=0x000000@0.65:boxborderw=12:x=(w-text_w)/2:" +
          "y=h-text_h-h/12:enable='between(t,0.000000,1.500000)'[captioned0]"
      ].join(';')
      expect(() => validateAndSubstituteFfmpegArguments(
        ['-i', '{{input:source}}', '-filter_complex', graph, '-map', '[captioned0]', '{{output:video}}'],
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).not.toThrow()
    })

  it('accepts the bounded progressive filmstrip filter chain', () => {
      expect(() => validateAndSubstituteFfmpegArguments(
        [
          '-nostdin', '-i', '{{input:source}}', '-vf',
          'fps=1/5.000000,scale=320:-2,tile=3x1',
          '-frames:v', '1', '-f', 'image2', '{{output:filmstrip}}'
        ],
        { source: '/host/source.mp4' },
        { filmstrip: '/host/.staging.png' }
      )).not.toThrow()
    })

  it('accepts the reviewed deterministic CPU effect filters', () => {
      const graph = [
        '[0:v]eq=brightness=0.1:contrast=1.2:saturation=0.9:gamma=1.1,' +
          'colorbalance=rs=0.1:bs=-0.1:gm=0.05,' +
          'boxblur=luma_radius=4:luma_power=1:chroma_radius=4:chroma_power=1,' +
          'unsharp=5:5:1.25:5:5:0,vignette=angle=1.204277[effected]',
        '[effected]scale=1280:720:flags=lanczos,fps=24/1[output]'
      ].join(';')
      expect(() => validateAndSubstituteFfmpegArguments(
        ['-i', '{{input:source}}', '-filter_complex', graph, '-map', '[output]', '{{output:video}}'],
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).not.toThrow()
    })

  it.each([
      [
        'H.265 MP4',
        [
          '-c:v', 'libx265', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p',
          '-tag:v', 'hvc1', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k',
          '-movflags', '+faststart', '-f', 'mp4'
        ]
      ],
      [
        'ProRes MOV',
        [
          '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le',
          '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2', '-f', 'mov'
        ]
      ],
      [
        'FFV1 Matroska portable fallback',
        [
          '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1',
          '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2',
          '-f', 'matroska'
        ]
      ]
    ])('accepts the reviewed %s advanced export profile', (_label, codecArgs) => {
      expect(() => validateAndSubstituteFfmpegArguments(
        [
          '-nostdin', '-i', '{{input:source}}', '-vf',
          'scale=1280:720:flags=lanczos,fps=24/1',
          '-map', '0:v:0', '-map', '0:a:0',
          ...codecArgs,
          '{{output:video}}'
        ],
        { source: '/host/source.mp4' },
        { video: '/host/.staging-output' }
      )).not.toThrow()
    })

  it.each([
      ['-i', 'https://example.com/video.mp4', '{{output:video}}'],
      ['-i', '../secret.mp4', '{{output:video}}'],
      ['-i', '@args.txt', '{{output:video}}'],
      ['-i', '{{input:source}}', '-filter_script', 'filter.txt', '{{output:video}}'],
      ['-i', '{{input:source}}', '-vf', 'movie=/etc/passwd', '{{output:video}}'],
      ['-i', '{{input:source}}', '-progress', 'pipe:2', '{{output:video}}'],
      ['-f', 'concat', '-safe', '0', '-i', '{{input:source}}', '{{output:video}}'],
      ['-i', '{{input:source}}', '-f', 'hls', '{{output:video}}'],
      ['-i', '{{input:source}}', '-pass', '1', '{{output:video}}'],
      ['-i', '{{input:source}}', '-passlogfile:v', '{{output:video}}'],
      ['-i', '{{input:source}}', '-dump_attachment:t:0', '{{output:video}}'],
      ['-i', '{{input:source}}', '-hls_segment_filename', '{{output:video}}']
    ])('rejects undeclared paths, protocols, response files, and Host-reserved options', (...args) => {
      expect(() => validateAndSubstituteFfmpegArguments(
        args,
        { source: '/host/source.mp4' },
        { video: '/host/.staging.mp4' }
      )).toThrow()
    })
})
