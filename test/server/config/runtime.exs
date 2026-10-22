import Config

port = "PORT" |> System.get_env("4099") |> String.to_integer()

config :test_server, TestServer.Endpoint,
  adapter: Phoenix.Endpoint.Cowboy2Adapter,
  http: [ip: {127, 0, 0, 1}, port: port],
  server: true,
  secret_key_base: String.duplicate("apollo-link-absinthe-test-server", 4),
  pubsub_server: TestServer.PubSub,
  check_origin: false
