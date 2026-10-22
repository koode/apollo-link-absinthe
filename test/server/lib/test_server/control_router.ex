defmodule TestServer.ControlRouter do
  @moduledoc "The HTTP control API of the test server. Only the tests call it."
  use Plug.Router

  alias TestServer.{Endpoint, State, Ticks}

  @settings %{
    "joinMode" => :join_mode,
    "joinDelayMs" => :join_delay_ms,
    "docDelays" => :doc_delays,
    "unsubscribeMode" => :unsubscribe_mode
  }

  plug :match
  plug :dispatch

  get "/health" do
    send_resp(conn, 200, "ok")
  end

  post "/control/reset" do
    State.reset()
    send_resp(conn, 204, "")
  end

  post "/control/settings" do
    for {name, value} <- conn.body_params, Map.has_key?(@settings, name) do
      State.put(Map.fetch!(@settings, name), value)
    end

    send_resp(conn, 204, "")
  end

  get "/control/state" do
    state = %{
      connects: State.get(:connects),
      log: State.get(:log),
      subscriptions: subscription_count()
    }

    json(conn, state)
  end

  post "/control/publish" do
    %{"topic" => topic, "value" => value} = conn.body_params
    Ticks.publish(topic, value, conn.body_params["fail"] == true)
    send_resp(conn, 204, "")
  end

  # Disconnects every socket of a user, as an app does when a session is revoked.
  post "/control/disconnect" do
    user = conn.body_params["user"] || "anonymous"
    Endpoint.broadcast("user_socket:#{user}", "disconnect", %{})
    send_resp(conn, 204, "")
  end

  post "/control/channels/close" do
    Endpoint.broadcast("__absinthe__:control", "test:close", %{})
    send_resp(conn, 204, "")
  end

  post "/control/channels/crash" do
    Endpoint.broadcast("__absinthe__:control", "test:crash", %{})
    send_resp(conn, 204, "")
  end

  match _ do
    send_resp(conn, 404, "not found")
  end

  defp json(conn, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(body))
  end

  # The subscription documents Absinthe holds, all sockets together.
  defp subscription_count do
    registry = Absinthe.Subscription.registry_name(Endpoint)
    keys = Registry.select(registry, [{{:"$1", :_, :_}, [], [:"$1"]}])
    keys |> Enum.filter(&is_binary/1) |> Enum.uniq() |> length()
  end
end
