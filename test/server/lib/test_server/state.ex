defmodule TestServer.State do
  @moduledoc """
  What the tests set (join mode, doc delays, unsubscribe mode) and what the
  server saw (connects, docs, unsubscribes).
  """
  use Agent

  @initial %{
    join_mode: "normal",
    join_delay_ms: 0,
    doc_delays: [],
    unsubscribe_mode: "normal",
    connects: [],
    log: []
  }

  def start_link(_options), do: Agent.start_link(fn -> @initial end, name: __MODULE__)

  def reset, do: Agent.update(__MODULE__, fn _state -> @initial end)

  def get(key), do: Agent.get(__MODULE__, &Map.fetch!(&1, key))

  def put(key, value), do: Agent.update(__MODULE__, &Map.put(&1, key, value))

  def record_connect(connect) do
    Agent.update(__MODULE__, fn state -> %{state | connects: state.connects ++ [connect]} end)
  end

  def record(event) do
    Agent.update(__MODULE__, fn state -> %{state | log: state.log ++ [event]} end)
  end

  @doc "The delay for the next `doc`; each configured delay is used once."
  def next_doc_delay do
    Agent.get_and_update(__MODULE__, fn
      %{doc_delays: [delay | rest]} = state -> {delay, %{state | doc_delays: rest}}
      state -> {0, state}
    end)
  end
end
