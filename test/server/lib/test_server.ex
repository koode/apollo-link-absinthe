defmodule TestServer do
  @moduledoc """
  A Phoenix + Absinthe server for the apollo-link-absinthe test suite. It runs the
  versions of a production Absinthe app and exposes an HTTP control API under
  `/control` that the tests use to publish, drop sockets, crash or close
  channels, and read what the server saw.
  """
end
