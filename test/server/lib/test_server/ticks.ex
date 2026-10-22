defmodule TestServer.Ticks do
  @moduledoc "Publishes a tick to every subscription field on its topic."

  @fields [:ticked, :ticked_for, :shared, :fails_at_publish, :private_ticked, :raced_ticked]

  def publish(topic, value, fail) do
    tick = %{topic: topic, value: value, fail: fail}
    topics = Enum.map(@fields, fn field -> {field, topic} end)
    :ok = Absinthe.Subscription.publish(TestServer.Endpoint, tick, topics)
    tick
  end
end
