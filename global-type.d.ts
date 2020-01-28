//@ts-ignore
import { PrismaClient } from '@prisma/client'

declare global {
  interface nexusFutureTestContextApp {
    db: {
      client: PrismaClient
    }
  }
}
