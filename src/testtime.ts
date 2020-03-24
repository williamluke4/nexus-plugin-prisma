import { createTesttimeDimension } from 'nexus-future/plugin'
import { getPrismaClientInstance } from 'utils'

export default createTesttimeDimension(() => {
  return {
    app: {
      db: {
        client: getPrismaClientInstance(),
      },
    },
  }
})
