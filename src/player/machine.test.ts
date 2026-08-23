import { describe, expect, it } from "vitest";
import {
  type Action,
  type Deps,
  type PlayerState,
  initialState,
  reduce,
} from "./machine";

/** Перемешивание задом наперёд: предсказуемо, значит проверяемо. */
const deps: Deps = { shuffle: (ids) => [...ids].reverse() };

/** Прогоняет список действий поверх начального состояния. */
function run(actions: Action[], from: PlayerState = initialState()): PlayerState {
  return actions.reduce((state, action) => reduce(state, action, deps), from);
}

const LIBRARY: Action = { type: "library", ids: [1, 2, 3, 4] };

describe("порядок и переходы", () => {
  it("вперёд идёт по списку", () => {
    const state = run([LIBRARY, { type: "play", id: 1 }, { type: "next", reason: "user" }]);
    expect(state.currentId).toBe(2);
  });

  it("конец списка без повтора останавливает перебор", () => {
    const state = run([LIBRARY, { type: "play", id: 4 }, { type: "next", reason: "ended" }]);
    expect(state.atEnd).toBe(true);
    expect(state.currentId).toBe(4);
  });
});

describe("повтор", () => {
  it("повтор одного перезапускает трек по естественному окончанию", () => {
    const before = run([LIBRARY, { type: "play", id: 2 }, { type: "cycleRepeat" }, { type: "cycleRepeat" }]);
    expect(before.repeat).toBe("one");

    const after = reduce(before, { type: "next", reason: "ended" }, deps);
    expect(after.currentId).toBe(2);
    expect(after.generation).toBe(before.generation + 1);
  });

  it("кнопка «вперёд» сильнее повтора одного и не сбрасывает режим", () => {
    const before = run([LIBRARY, { type: "play", id: 2 }, { type: "cycleRepeat" }, { type: "cycleRepeat" }]);
    const after = reduce(before, { type: "next", reason: "user" }, deps);

    expect(after.currentId).toBe(3);
    expect(after.repeat).toBe("one");
  });

  it("режим повтора идёт по кругу: выкл → все → один → выкл", () => {
    let state = run([LIBRARY]);
    expect(state.repeat).toBe("off");
    state = reduce(state, { type: "cycleRepeat" }, deps);
    expect(state.repeat).toBe("all");
    state = reduce(state, { type: "cycleRepeat" }, deps);
    expect(state.repeat).toBe("one");
    state = reduce(state, { type: "cycleRepeat" }, deps);
    expect(state.repeat).toBe("off");
  });

  it("повтор всех с конца списка возвращает в начало", () => {
    const state = run([
      LIBRARY,
      { type: "cycleRepeat" },
      { type: "play", id: 4 },
      { type: "next", reason: "ended" },
    ]);
    expect(state.currentId).toBe(1);
    expect(state.atEnd).toBe(false);
  });
});

describe("шафл", () => {
  it("перемешивает заново на втором круге", () => {
    // Первый круг: порядок 4,3,2,1. Доходим до конца и ждём нового перемешивания.
    const state = run([
      LIBRARY,
      { type: "play", id: 1 },
      { type: "toggleShuffle" },
      { type: "cycleRepeat" },
    ]);
    expect(state.playOrder).toEqual([1, 4, 3, 2]);

    // Прокручиваем до конца списка.
    let cycled = state;
    for (let i = 0; i < 3; i += 1) {
      cycled = reduce(cycled, { type: "next", reason: "ended" }, deps);
    }
    expect(cycled.currentId).toBe(2);

    const wrapped = reduce(cycled, { type: "next", reason: "ended" }, deps);
    expect(wrapped.playOrder).toEqual([4, 3, 2, 1]);
    expect(wrapped.currentId).toBe(4);
  });

  it("выключение шафла оставляет текущий трек и возвращает соседа по списку", () => {
    const shuffled = run([LIBRARY, { type: "play", id: 3 }, { type: "toggleShuffle" }]);
    expect(shuffled.currentId).toBe(3);

    const back = reduce(shuffled, { type: "toggleShuffle" }, deps);
    expect(back.currentId).toBe(3);
    expect(back.playOrder).toEqual([1, 2, 3, 4]);

    const next = reduce(back, { type: "next", reason: "user" }, deps);
    expect(next.currentId).toBe(4);
  });

  it("включение шафла не обрывает играющий трек", () => {
    const before = run([LIBRARY, { type: "play", id: 2 }]);
    const after = reduce(before, { type: "toggleShuffle" }, deps);

    expect(after.currentId).toBe(2);
    expect(after.generation).toBe(before.generation);
    expect(after.playOrder[0]).toBe(2);
  });
});

describe("очередь", () => {
  it("трек из очереди играет следующим", () => {
    const state = run([LIBRARY, { type: "play", id: 1 }, { type: "enqueue", id: 4 }]);
    const next = reduce(state, { type: "next", reason: "ended" }, deps);
    expect(next.currentId).toBe(4);
    expect(next.queue).toEqual([]);
  });

  it("шафл не влияет на очередь", () => {
    const state = run([
      LIBRARY,
      { type: "play", id: 1 },
      { type: "toggleShuffle" },
      { type: "enqueue", id: 3 },
    ]);
    expect(reduce(state, { type: "next", reason: "ended" }, deps).currentId).toBe(3);
  });

  it("после очереди перебор продолжается с того же места", () => {
    const state = run([LIBRARY, { type: "play", id: 1 }, { type: "enqueue", id: 4 }]);
    const fromQueue = reduce(state, { type: "next", reason: "ended" }, deps);
    const afterQueue = reduce(fromQueue, { type: "next", reason: "ended" }, deps);
    expect(afterQueue.currentId).toBe(2);
  });

  it("трек можно вынуть из очереди по позиции", () => {
    const state = run([
      LIBRARY,
      { type: "enqueue", id: 3 },
      { type: "enqueue", id: 4 },
      { type: "dequeue", index: 0 },
    ]);
    expect(state.queue).toEqual([4]);
  });

  it("одинаковые треки в очереди убираются по одному", () => {
    // Поставить трек дважды — законно, поэтому удаление по идентификатору
    // вынесло бы оба сразу.
    const state = run([
      LIBRARY,
      { type: "enqueue", id: 3 },
      { type: "enqueue", id: 3 },
      { type: "dequeue", index: 0 },
    ]);
    expect(state.queue).toEqual([3]);
  });

  it("очередь очищается целиком", () => {
    const state = run([
      LIBRARY,
      { type: "enqueue", id: 2 },
      { type: "enqueue", id: 3 },
      { type: "clearQueue" },
    ]);
    expect(state.queue).toEqual([]);
  });

  it("очистка очереди не трогает текущий трек", () => {
    const before = run([LIBRARY, { type: "play", id: 1 }, { type: "enqueue", id: 3 }]);
    const after = reduce(before, { type: "clearQueue" }, deps);
    expect(after.currentId).toBe(1);
    expect(after.generation).toBe(before.generation);
  });
});

describe("включение альбома", () => {
  it("первый трек играет, остальные встают в очередь по порядку", () => {
    const state = run([LIBRARY, { type: "playAll", ids: [3, 1, 4] }]);
    expect(state.currentId).toBe(3);
    expect(state.queue).toEqual([1, 4]);
  });

  it("новый альбом заменяет прежнюю очередь, а не дополняет её", () => {
    const state = run([
      LIBRARY,
      { type: "enqueue", id: 2 },
      { type: "playAll", ids: [3, 4] },
    ]);
    expect(state.queue).toEqual([4]);
  });

  it("пустой альбом ничего не меняет", () => {
    const before = run([LIBRARY, { type: "play", id: 1 }]);
    const after = reduce(before, { type: "playAll", ids: [] }, deps);
    expect(after).toEqual(before);
  });

  it("альбом из одного трека не оставляет мусора в очереди", () => {
    const state = run([LIBRARY, { type: "playAll", ids: [2] }]);
    expect(state.currentId).toBe(2);
    expect(state.queue).toEqual([]);
  });
});

describe("кнопка «назад»", () => {
  it("после трёх секунд начинает текущий заново", () => {
    const before = run([LIBRARY, { type: "play", id: 3 }]);
    const after = reduce(before, { type: "prev", position: 12 }, deps);

    expect(after.currentId).toBe(3);
    expect(after.generation).toBe(before.generation + 1);
  });

  it("в первые три секунды уходит на предыдущий трек", () => {
    const state = run([LIBRARY, { type: "play", id: 3 }, { type: "prev", position: 1.2 }]);
    expect(state.currentId).toBe(2);
  });

  it("ровно на пороге считается перезапуском", () => {
    const state = run([LIBRARY, { type: "play", id: 3 }, { type: "prev", position: 3 }]);
    expect(state.currentId).toBe(3);
  });

  it("с первого трека назад уходить некуда — перезапуск", () => {
    const state = run([LIBRARY, { type: "play", id: 1 }, { type: "prev", position: 0.5 }]);
    expect(state.currentId).toBe(1);
  });
});

describe("удаление трека", () => {
  it("играющий трек не обрывается, а следующим идёт тот, что шёл за ним", () => {
    const state = run([LIBRARY, { type: "play", id: 2 }, { type: "remove", id: 2 }]);
    expect(state.currentId).toBe(2);
    expect(state.order).toEqual([1, 3, 4]);

    const next = reduce(state, { type: "next", reason: "ended" }, deps);
    expect(next.currentId).toBe(3);
  });

  it("удаление трека выше по списку не сбивает перебор", () => {
    const state = run([LIBRARY, { type: "play", id: 3 }, { type: "remove", id: 1 }]);
    const next = reduce(state, { type: "next", reason: "user" }, deps);
    expect(next.currentId).toBe(4);
  });

  it("удалённый трек исчезает из очереди", () => {
    const state = run([LIBRARY, { type: "enqueue", id: 4 }, { type: "remove", id: 4 }]);
    expect(state.queue).toEqual([]);
  });
});

describe("токен поколения", () => {
  it("растёт при каждом запуске трека с нуля", () => {
    const first = run([LIBRARY, { type: "play", id: 1 }]);
    const second = reduce(first, { type: "next", reason: "user" }, deps);
    const third = reduce(second, { type: "next", reason: "user" }, deps);

    expect(second.generation).toBe(first.generation + 1);
    expect(third.generation).toBe(second.generation + 1);
  });

  it("не растёт от переключения режимов", () => {
    const before = run([LIBRARY, { type: "play", id: 1 }]);
    const after = run([{ type: "cycleRepeat" }, { type: "enqueue", id: 3 }], before);
    expect(after.generation).toBe(before.generation);
  });

  it("быстрое перелистывание даёт строго растущие поколения", () => {
    // Ровно тот случай, ради которого токен и заведён: три нажатия подряд
    // должны дать три разных поколения, чтобы догрузка старого трека
    // могла быть отброшена.
    let state = run([LIBRARY, { type: "play", id: 1 }]);
    const seen = [state.generation];

    for (let i = 0; i < 3; i += 1) {
      state = reduce(state, { type: "next", reason: "user" }, deps);
      seen.push(state.generation);
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
