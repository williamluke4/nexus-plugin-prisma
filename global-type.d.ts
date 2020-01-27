//@ts-ignore
import { PrismaClient } from '@prisma/client'

declare global {
  interface GraphQLSantaTestContextApp {
    db: {
      client: PrismaClient
    }
  }
}
