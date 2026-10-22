/** The documents of the test schema, printed the way graphql's print() does. */
export const tickedQuery = "subscription { ticked { topic value } }";
export const tickedForQuery =
  "subscription TickedFor($topic: String!, $scale: Int) { tickedFor(topic: $topic, scale: $scale) { topic value } }";
export const sharedQuery =
  "subscription Shared($topic: String!) { shared(topic: $topic) { topic value } }";
export const refusedQuery = "subscription { refused { value } }";
export const refusedWithCodeQuery =
  "subscription { refusedWithCode { value } }";
export const failsAtPublishQuery =
  "subscription FailsAtPublish($topic: String!) { failsAtPublish(topic: $topic) { topic value } }";
export const privateTickedQuery =
  "subscription { privateTicked { topic value } }";
export const racedTickedQuery =
  "subscription Raced($topic: String!) { racedTicked(topic: $topic) { topic value } }";
export const crashesQuery = "subscription { crashes { value } }";
