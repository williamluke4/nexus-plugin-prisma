import { createTesttimeDimension } from 'nexus-future/plugin'

export default createTesttimeDimension(() => ({
  app: {
    db: {
      client: getPrismaClientInstance(),
    },
  },
}))
