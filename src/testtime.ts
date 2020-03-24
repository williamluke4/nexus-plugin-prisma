import { createTesttimeDimension } from 'nexus-future/plugin'
import { getPrismaClientInstance } from 'utils'

export default createTesttimeDimension(() => ({
  app: {
    db: {
      client: getPrismaClientInstance(),
    },
  },
}))
