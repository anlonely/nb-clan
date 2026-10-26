export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export function createLatestRequestController() {
  let active = true;
  let epoch = 0;
  let controller = null;

  function cancel() {
    epoch += 1;
    controller?.abort();
    controller = null;
  }

  return {
    activate() {
      active = true;
    },
    begin() {
      controller?.abort();
      controller = new AbortController();
      const request = {
        epoch: ++epoch,
        signal: controller.signal
      };
      if (!active) controller.abort();
      return request;
    },
    cancel,
    dispose() {
      active = false;
      cancel();
    },
    finish(request) {
      if (request?.epoch === epoch) controller = null;
    },
    isCurrent(request) {
      return Boolean(
        active &&
        request &&
        request.epoch === epoch &&
        !request.signal.aborted
      );
    }
  };
}
