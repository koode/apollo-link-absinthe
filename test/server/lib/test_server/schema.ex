defmodule TestServer.Schema do
  @moduledoc """
  Every subscription case the link has to carry: plain, with variables, a
  shared id (`context_id`), refusals with and without `extensions.code`, an
  error inside a pushed result, an authorization check on the connect token,
  a race between data and the doc reply, and a `config` that crashes.
  """
  use Absinthe.Schema

  alias TestServer.Ticks

  object :tick do
    field :topic, non_null(:string)
    field :value, non_null(:integer)
  end

  query do
    field :hello, non_null(:string) do
      arg :name, :string
      resolve fn args, _resolution -> {:ok, "Hello #{args[:name] || "world"}"} end
    end

    field :failing, :string do
      resolve fn _args, _resolution ->
        {:error, %{message: "Query failed", extensions: %{code: "QUERY_FAILED"}}}
      end
    end
  end

  mutation do
    field :publish_tick, non_null(:tick) do
      arg :topic, non_null(:string)
      arg :value, non_null(:integer)

      resolve fn args, _resolution ->
        tick = Ticks.publish(args.topic, args.value, false)
        {:ok, tick}
      end
    end
  end

  subscription do
    field :ticked, :tick do
      config fn _args, _resolution -> {:ok, topic: "ticked"} end
    end

    field :ticked_for, :tick do
      arg :topic, non_null(:string)
      arg :scale, :integer
      config fn args, _resolution -> {:ok, topic: args.topic} end

      resolve fn tick, args, _resolution ->
        scaled = %{tick | value: tick.value * (args[:scale] || 1)}
        {:ok, scaled}
      end
    end

    # With context_id set, two identical docs on one socket get the same id.
    field :shared, :tick do
      arg :topic, non_null(:string)
      config fn args, _resolution -> {:ok, topic: args.topic, context_id: "all"} end
    end

    # A common way to refuse: the code is the message, there are no extensions.
    field :refused, :tick do
      config fn _args, _resolution -> {:error, "FORBIDDEN"} end
    end

    field :refused_with_code, :tick do
      config fn _args, _resolution ->
        {:error, %{message: "Not allowed here", extensions: %{code: "FORBIDDEN"}, reason: "test"}}
      end
    end

    field :fails_at_publish, :tick do
      arg :topic, non_null(:string)
      config fn args, _resolution -> {:ok, topic: args.topic} end
      resolve &fail_when_asked/3
    end

    # Authorized by the token the socket connected with.
    field :private_ticked, :tick do
      config &private_topic/2
    end

    field :raced_ticked, :tick do
      arg :topic, non_null(:string)
      config fn args, _resolution -> {:ok, topic: args.topic} end
    end

    field :crashes, :tick do
      config fn _args, _resolution -> raise "config crashed" end
    end
  end

  defp fail_when_asked(%{fail: true}, _args, _resolution) do
    {:error, %{message: "Publish failed", extensions: %{code: "PUBLISH_FAILED"}, detail: "kept"}}
  end

  defp fail_when_asked(tick, _args, _resolution), do: {:ok, tick}

  defp private_topic(_args, %{context: %{current_user: user}}) when is_binary(user) do
    {:ok, topic: "private:#{user}"}
  end

  defp private_topic(_args, _resolution) do
    {:error, %{message: "Sign in first", extensions: %{code: "UNAUTHENTICATED"}}}
  end
end
