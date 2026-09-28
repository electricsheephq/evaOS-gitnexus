class HookMixin:
    def dispatch(self) -> int:
        return self.hook()
