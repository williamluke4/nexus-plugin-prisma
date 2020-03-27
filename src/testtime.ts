import * as NexusPlugin from 'nexus-future/plugin'
import { getPrismaClientInstance } from './lib/prisma-client'

export function testTimePlugin(_project: NexusPlugin.Lens) {
  const plugin = () => {
    return {
      app: {
        db: {
          client: getPrismaClientInstance(),
        },
      },
    }
  }

  return plugin
}
