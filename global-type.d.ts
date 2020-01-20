//@ts-ignore
import { Photon } from '@prisma/photon'

declare global {
  interface GraphQLSantaTestContextApp {
    db: {
      client: Photon
    }
  }
}