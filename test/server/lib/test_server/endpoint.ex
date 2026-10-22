defmodule TestServer.Endpoint do
  use Phoenix.Endpoint, otp_app: :test_server
  use Absinthe.Phoenix.Endpoint

  # auth_token: the phoenix 1.8 client sends its token in the WebSocket
  # subprotocol header. Clients without it still connect with params.
  socket "/socket", TestServer.UserSocket, websocket: true, longpoll: false, auth_token: true

  plug Plug.Parsers, parsers: [:json], pass: ["*/*"], json_decoder: Jason
  plug TestServer.ControlRouter
end
