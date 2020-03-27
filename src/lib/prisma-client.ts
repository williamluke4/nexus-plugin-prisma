import * as Path from 'path'
import { linkableRequire, linkableResolve } from './linkable'

let prismaClientInstance: object | null = null

export function getPrismaClientInstance() {
  if (!prismaClientInstance) {
    const { PrismaClient } = linkableRequire('@prisma/client')

    prismaClientInstance = new PrismaClient()
  }

  return prismaClientInstance
}

// HACK
// 1. https://prisma-company.slack.com/archives/C8AKVD5HU/p1574267904197600
// 2. https://prisma-company.slack.com/archives/CEYCG2MCN/p1574267824465700
export function getPrismaClientDir() {
  return Path.dirname(linkableResolve('@prisma/client'))
}
