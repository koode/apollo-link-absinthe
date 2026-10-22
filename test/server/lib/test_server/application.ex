defmodule TestServer.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Phoenix.PubSub, name: TestServer.PubSub},
      TestServer.State,
      TestServer.Endpoint,
      {Absinthe.Subscription, TestServer.Endpoint},
      TestServer.StdinWatcher
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: TestServer.Supervisor)
  end
end
