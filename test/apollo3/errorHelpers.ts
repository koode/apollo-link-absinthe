import type { ApolloError } from "@apollo/client-3";
import type { ErrorResponse } from "@apollo/client-3/link/error";

/**
 * Copies of the error helpers of an Apollo 3 app in production, run against
 * what the link produces, so a change that would break such an app shows here.
 */
interface IServerErrorLike {
  result?: { errors?: unknown };
}

export interface IFormattedError {
  title: string;
  description: string;
}

function getErrorCodes(error: ApolloError | ErrorResponse): string[] {
  const serverErrors = (
    error.networkError as IServerErrorLike | null | undefined
  )?.result?.errors;
  const graphQLErrors: { extensions?: { code?: unknown } }[] = [
    ...(error.graphQLErrors ?? []),
    ...(Array.isArray(serverErrors) ? serverErrors : []),
  ];
  return graphQLErrors.flatMap(({ extensions }) =>
    typeof extensions?.code === "string" ? [extensions.code] : [],
  );
}

export function hasErrorCode(
  error: ApolloError | ErrorResponse,
  codes: string | string[],
): boolean {
  return getErrorCodes(error).some((code) => [codes].flat().includes(code));
}

export function formatGraphQLError(
  error: ApolloError | ErrorResponse,
): IFormattedError {
  if (error.networkError) {
    const { name, message } = error.networkError;
    return {
      title: "An error occured while communicating with the server",
      description: `(${name}): ${message}`,
    };
  }
  if (error.graphQLErrors?.length) {
    const description = error.graphQLErrors
      .map((graphQLError) => graphQLError.message)
      .join(", ");
    return { title: "API error", description };
  }
  return { title: "Unknown error", description: "An unknown error occurred" };
}
