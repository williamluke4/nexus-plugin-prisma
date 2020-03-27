# Development

## `@nexus/schema` & `graphql`

- Dependend upon because `nexus-prisma` has them as peer deps
- While `nexus` brings them, relying on that would be relying on their being hoisting, which we should not
- For more detail see https://github.com/graphql-nexus/nexus-future/issues/514#issuecomment-604668904
