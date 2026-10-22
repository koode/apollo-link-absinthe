defmodule TestServer.Phase.SubscribeSelf do
  @moduledoc """
  Absinthe's SubscribeSelf phase, plus error maps for `config`.

  Absinthe takes `{:error, message}` from a subscription `config` as a plain
  message: a map ends up whole in `message`. This phase turns
  `{:error, %{message: ..., extensions: %{code: ...}}}` into an error with
  that message and the other fields beside it, so the refusal reaches the
  client with `extensions.code`, as a resolver error does.
  """
  use Absinthe.Phase

  alias Absinthe.{Phase, Pipeline}

  @impl true
  def run(blueprint, options) do
    # Absinthe stores these phases with the subscription and runs them again on
    # every publish, minus the stock SubscribeSelf. Store the stock phase, so a
    # publish does not subscribe again.
    stock_phases =
      Pipeline.replace(blueprint.initial_phases, __MODULE__, Phase.Subscription.SubscribeSelf)

    stored = %{blueprint | initial_phases: stock_phases}

    case Phase.Subscription.SubscribeSelf.run(stored, options) do
      {:replace, replaced, pipeline} ->
        expanded = expand_errors(replaced)
        {:replace, expanded, pipeline}

      other ->
        other
    end
  end

  defp expand_errors(blueprint) do
    update_in(blueprint.execution.validation_errors, fn errors ->
      Enum.map(errors, &expand_error/1)
    end)
  end

  defp expand_error(%Phase.Error{message: %{message: message} = details} = error) do
    extra = Map.delete(details, :message)
    %{error | message: message, extra: extra}
  end

  defp expand_error(error), do: error
end
