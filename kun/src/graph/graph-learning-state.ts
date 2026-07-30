import { z } from 'zod'
import {
  GRAPH_CONTRACT_VERSION,
  GraphEpisodeV1Schema,
  GraphLearningJobV1Schema
} from '../contracts/index.js'

export const GraphLearningStateSchema = z.object({
  version: z.literal(GRAPH_CONTRACT_VERSION),
  episodes: z.array(GraphEpisodeV1Schema).max(1_000_000),
  jobs: z.array(GraphLearningJobV1Schema).max(100_000),
  updatedAt: z.string().datetime({ offset: true })
}).strict()

export type GraphLearningState = z.infer<typeof GraphLearningStateSchema>
