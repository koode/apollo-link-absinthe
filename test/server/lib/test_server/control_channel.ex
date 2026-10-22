defmodule TestServer.ControlChannel do
  @moduledoc """
  `Absinthe.Phoenix.Channel` with test hooks around it: a join that is
  refused or slow, docs that answer late, an unsubscribe that fails, a data
  push that beats the doc reply, and a broadcast that closes or crashes every
  control channel.
  """
  use Phoenix.Channel

  alias Absinthe.Phoenix.Channel, as: AbsintheChannel
  alias TestServer.State

  intercept ["test:close", "test:crash"]

  @impl true
  def join(topic, payload, socket) do
    case State.get(:join_mode) do
      "reject" ->
        {:error, %{reason: "refused by the test server"}}

      "slow" ->
        Process.sleep(State.get(:join_delay_ms))
        AbsintheChannel.join(topic, payload, socket)

      "normal" ->
        AbsintheChannel.join(topic, payload, socket)
    end
  end

  @impl true
  def handle_in("doc", payload, socket) do
    State.record(%{event: "doc", query: payload["query"], variables: payload["variables"]})
    delay = State.next_doc_delay()
    if delay > 0, do: Process.sleep(delay)
    result = AbsintheChannel.handle_in("doc", payload, socket)
    push_before_reply(payload, result)
    result
  end

  def handle_in("unsubscribe", payload, socket) do
    State.record(%{event: "unsubscribe", subscriptionId: payload["subscriptionId"]})

    case State.get(:unsubscribe_mode) do
      "error" -> {:reply, {:error, %{reason: "refused by the test server"}}, socket}
      "silent" -> {:noreply, socket}
      "normal" -> AbsintheChannel.handle_in("unsubscribe", payload, socket)
    end
  end

  def handle_in(event, payload, socket), do: AbsintheChannel.handle_in(event, payload, socket)

  @impl true
  def handle_info(message, socket), do: AbsintheChannel.handle_info(message, socket)

  @impl true
  def handle_out("test:close", _payload, socket), do: {:stop, {:shutdown, :closed}, socket}
  def handle_out("test:crash", _payload, _socket), do: raise("crashed by the test server")

  # Absinthe subscribes before it replies, so a publish can reach the client
  # before the reply with the id. `racedTicked` makes that happen every time.
  defp push_before_reply(%{"query" => query}, {:reply, {:ok, %{subscriptionId: id}}, socket}) do
    if String.contains?(query, "racedTicked") do
      result = %{data: %{"racedTicked" => %{"value" => -1, "topic" => "raced"}}}

      broadcast = %Phoenix.Socket.Broadcast{
        topic: id,
        event: "subscription:data",
        payload: %{result: result, subscriptionId: id}
      }

      send(socket.transport_pid, socket.serializer.fastlane!(broadcast))
    end
  end

  defp push_before_reply(_payload, _result), do: :ok
end
