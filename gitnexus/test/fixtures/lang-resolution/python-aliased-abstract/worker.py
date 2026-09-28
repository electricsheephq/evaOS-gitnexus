from abc import ABC, abstractmethod as am

from mixins import HookMixin


class GoodWorker(HookMixin):
    def hook(self) -> int:
        return 1


class AliasedAbstractWorker(HookMixin, ABC):
    @am
    def hook(self) -> int:
        raise NotImplementedError


class ConcreteWorker(AliasedAbstractWorker):
    def hook(self) -> int:
        return 2
