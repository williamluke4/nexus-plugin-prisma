import { createRuntimeDimension } from 'nexus-future/plugin'

export default createRuntimeDimension(() => {
  project.utils.log.trace('start')
  const prisma = getPrismaClientInstance()

  return {
    context: {
      create: _req => {
        return { db: prisma }
      },
      typeGen: {
        fields: {
          db: 'Prisma.PrismaClient',
        },
        // import not needed here because it will already be from the
        // typegenAutoConfig below
        // imports: [
        //   {
        //     as: 'Photon',
        //     from: GENERATED_PHOTON_OUTPUT_PATH,
        //   },
        // ],
      },
    },
    nexus: {
      typegenAutoConfig: {
        // https://github.com/prisma-labs/nexus-prisma/blob/master/examples/hello-world/app.ts#L14
        sources: [
          {
            source: Path.join(
              GENERATED_PRISMA_CLIENT_OUTPUT_PATH,
              '/index.d.ts'
            ),
            alias: 'Prisma',
          },
        ],
      },
      plugins: [
        nexusPrismaPlugin({
          inputs: {
            prismaClient: GENERATED_PRISMA_CLIENT_OUTPUT_PATH,
          },
          outputs: {
            typegen: nexusPrismaTypegenOutput,
          },
          prismaClient: ctx => ctx.db,
          shouldGenerateArtifacts: shouldGenerateArtifacts(),
          onUnknownFieldName: params => renderUnknownFieldNameError(params),
          onUnknownFieldType: params => renderUnknownFieldTypeError(params),
        } as OptionsWithHook),
      ] as any, //TODO: REMOVE ME ONCE THE TRANSITION WITH NEXUS IS DONE. Reason: Type conflict between nexus and @nexus/schema
    },
  }
})
