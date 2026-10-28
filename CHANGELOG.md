# apollo-link-absinthe

## 0.1.0

### Minor Changes

- 53c2100: First release. A transport for Absinthe subscriptions over a Phoenix channel, with the Apollo Client 4 link at the package root and an Apollo Client 3.4+ entry at `apollo-link-absinthe/apollo3`. GraphQL errors reach the app with `extensions.code`, `path`, `locations` and every other field intact; transport failures are a typed `AbsintheSocketError`. Includes `createPhoenixSocket` with Phoenix 1.8 `authToken` (or URL params for older clients), read fresh before every connect and reconnect.
