import * as NexusPlugin from 'nexus-future/plugin'
import { runtimePlugin } from './runtime'
import { testTimePlugin } from './testtime'
import { worktimePlugin } from './worktime'

if (process.env.LINK) {
  process.env.NEXUS_PRISMA_LINK = process.env.LINK
}

export default NexusPlugin.create(project => {
  project.runtime(runtimePlugin(project))
  project.testing(testTimePlugin(project))
  project.workflow(worktimePlugin(project))
})
