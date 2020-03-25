import chalk from 'chalk'
import * as fs from 'fs-jetpack'
import { suggestionList } from 'lib/levenstein'
import { printStack } from 'lib/print-stack'
import { shouldGenerateArtifacts } from 'nexus-future/dist/runtime/schema/config'
import { createRuntimeDimension } from 'nexus-future/plugin'
import { nexusPrismaPlugin, Options } from 'nexus-prisma'
import * as Path from 'path'
import {
  GENERATED_PRISMA_CLIENT_OUTPUT_PATH,
  getPrismaClientInstance,
} from 'utils'

type UnknownFieldName = {
  error: Error
  unknownFieldName: string
  validFieldNames: string[]
  typeName: string
}

export type UnknownFieldType = {
  unknownFieldType: string
  error: Error
  typeName: string
  fieldName: string
}

type OptionsWithHook = Options & {
  onUnknownFieldName: (params: UnknownFieldName) => void
  onUnknownFieldType: (params: UnknownFieldType) => void
}

export default createRuntimeDimension(project => {
  const nexusPrismaTypegenOutput = fs.path(
    'node_modules/@types/typegen-nexus-prisma/index.d.ts'
  )
  project.log.trace('start')
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

/**
 * TODO ...
 */
function renderUnknownFieldTypeError(params: UnknownFieldType) {
  const { stack, fileLineNumber } = printStack({
    callsite: params.error.stack,
  })

  const intro = chalk`{yellow Warning:} ${params.error.message}\n{yellow Warning:} in ${fileLineNumber}`

  // todo use logger once "pretty" api done
  console.log(`${intro}${stack}`)
}

/**
 * TODO ...
 */
function renderUnknownFieldNameError(params: UnknownFieldName) {
  const { stack, fileLineNumber } = printStack({
    callsite: params.error.stack,
  })
  const suggestions = suggestionList(
    params.unknownFieldName,
    params.validFieldNames
  ).map(s => chalk.green(s))
  const suggestionMessage =
    suggestions.length === 0
      ? ''
      : chalk`{yellow Warning:} Did you mean ${suggestions
          .map(s => `"${s}"`)
          .join(', ')} ?`
  const intro = chalk`{yellow Warning:} ${params.error.message}\n{yellow Warning:} in ${fileLineNumber}\n${suggestionMessage}`

  // todo use logger once "pretty" api done
  console.log(`${intro}${stack}`)
}
