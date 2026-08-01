import { z } from 'zod'

export const COMPUTER_USE_BRIDGE_CONTRACT_VERSION = 1 as const
export const KUN_COMPUTER_USE_BRIDGE_URL_ENV = 'KUN_COMPUTER_USE_BRIDGE_URL'
export const KUN_COMPUTER_USE_BRIDGE_TOKEN_ENV = 'KUN_COMPUTER_USE_BRIDGE_TOKEN'

const requestBase = {
  contractVersion: z.literal(COMPUTER_USE_BRIDGE_CONTRACT_VERSION),
  requestId: z.string().min(1).max(256)
}
const coordinate = z.number().finite()

export const ComputerUseBridgeRequest = z.discriminatedUnion('operation', [
  z.object({ ...requestBase, operation: z.literal('ready') }).strict(),
  z.object({ ...requestBase, operation: z.literal('capture') }).strict(),
  z.object({ ...requestBase, operation: z.literal('screen_size') }).strict(),
  z.object({ ...requestBase, operation: z.literal('cursor_position') }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal('move_to'),
    x: coordinate,
    y: coordinate
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal('click'),
    x: coordinate.optional(),
    y: coordinate.optional(),
    button: z.enum(['left', 'right', 'middle']),
    count: z.union([z.literal(1), z.literal(2)]),
    modifiers: z.array(z.string().max(64)).max(16)
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal('drag'),
    x1: coordinate,
    y1: coordinate,
    x2: coordinate,
    y2: coordinate
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal('scroll'),
    x: coordinate.optional(),
    y: coordinate.optional(),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().finite().min(1).max(1_000)
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal('type_text'),
    text: z.string().max(100_000)
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal('press_hotkey'),
    key: z.string().min(1).max(256)
  }).strict(),
  z.object({
    ...requestBase,
    operation: z.literal('wait'),
    ms: z.number().finite().min(0).max(60_000)
  }).strict()
])

export type ComputerUseBridgeRequest = z.infer<typeof ComputerUseBridgeRequest>
export type ComputerUseBridgeRequestInput =
  ComputerUseBridgeRequest extends infer Request
    ? Request extends { contractVersion: number; requestId: string }
      ? Omit<Request, 'contractVersion' | 'requestId'>
      : never
    : never

export const ComputerUseBridgeResponse = z.object({
  contractVersion: z.literal(COMPUTER_USE_BRIDGE_CONTRACT_VERSION),
  requestId: z.string().min(1).max(256),
  result: z.unknown()
}).strict()

export type ComputerUseBridgeResponse = z.infer<typeof ComputerUseBridgeResponse>
