/* global Vue */

const { computed, createApp, ref, watch } = Vue;

const BOARDS_KEY = "boards";
const RESULTS_KEY = "results";

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readStorage(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

function normaliseBoards(value) {
  if (!Array.isArray(value)) return [];

  return value.map((board) => ({
    id: board.id || makeId(),
    name: typeof board.name === "string" ? board.name.trim() : "",
    rows: Array.isArray(board.rows)
      ? board.rows.map((row) => ({
          id: row.id || makeId(),
          question: typeof row.question === "string" ? row.question.trim() : "",
          answer: typeof row.answer === "string" ? row.answer.trim() : ""
        }))
      : []
  }));
}

function comparableText(value) {
  return value.trim().toLocaleLowerCase("fr");
}

createApp({
  setup() {
    const boards = ref(normaliseBoards(readStorage(BOARDS_KEY, [])));
    const results = ref(readStorage(RESULTS_KEY, {}));
    const view = ref("practice");
    const newBoardName = ref("");
    const selectedBoardIds = ref(boards.value.map((board) => board.id));
    const remainingQuestions = ref([]);
    const completedQuestionIds = ref([]);
    const currentQuestion = ref(null);
    const userAnswer = ref("");
    const isCorrect = ref(false);
    const phase = ref("idle");
    const storageError = ref("");
    const importMessage = ref("");

    const selectedBoards = computed(() =>
      boards.value.filter((board) => selectedBoardIds.value.includes(board.id))
    );
    const usableRows = (board) => board.rows.filter((row) => row.question.trim());
    const availableQuestions = computed(() =>
      selectedBoards.value.flatMap((board) =>
        usableRows(board).map((row) => ({ ...row, boardId: board.id, boardName: board.name || "Liste sans nom" }))
      )
    );
    const resultEntries = computed(() => Object.entries(results.value).sort(([a], [b]) => a.localeCompare(b, "fr")));

    function save(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        storageError.value = "";
      } catch {
        storageError.value = "La sauvegarde locale a échoué. Vérifie l’espace disponible du navigateur.";
      }
    }

    save(BOARDS_KEY, boards.value);
    watch(boards, (value) => {
      save(BOARDS_KEY, value);
      rebuildSessionStock();
    }, { deep: true });
    watch(results, (value) => save(RESULTS_KEY, value), { deep: true });
    watch(selectedBoardIds, rebuildSessionStock, { deep: true, immediate: true });
    watch(availableQuestions, () => {
      if (phase.value === "idle" && availableQuestions.value.length) startSession();
    });

    function selectAllBoards() {
      selectedBoardIds.value = boards.value.map((board) => board.id);
    }

    function addBoard() {
      const name = newBoardName.value.trim();
      if (!name) return;
      const board = { id: makeId(), name, rows: [{ id: makeId(), question: "", answer: "" }] };
      boards.value.push(board);
      selectedBoardIds.value.push(board.id);
      newBoardName.value = "";
    }

    function deleteBoard(id) {
      const board = boards.value.find((item) => item.id === id);
      if (!board || !window.confirm(`Supprimer la liste « ${board.name || "sans nom"} » ?`)) return;
      boards.value = boards.value.filter((item) => item.id !== id);
      selectedBoardIds.value = selectedBoardIds.value.filter((boardId) => boardId !== id);
      if (currentQuestion.value?.boardId === id) phase.value = "idle";
    }

    function addRow(board) {
      board.rows.push({ id: makeId(), question: "", answer: "" });
    }

    function deleteRow(board, rowId) {
      board.rows = board.rows.filter((row) => row.id !== rowId);
    }

    function exportBoards() {
      const portableBoards = boards.value.map((board) => ({
        name: board.name,
        rows: board.rows.map(({ question, answer }) => ({ question, answer }))
      }));
      const file = new Blob([JSON.stringify(portableBoards, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `listes-revision-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    async function importBoards(event) {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data)) throw new Error("format");

        let addedBoards = 0;
        let addedRows = 0;
        for (const importedBoard of data) {
          if (!importedBoard || typeof importedBoard.name !== "string" || !Array.isArray(importedBoard.rows)) continue;
          const name = importedBoard.name.trim();
          if (!name) continue;
          const rows = importedBoard.rows
            .filter((row) => row && typeof row.question === "string" && typeof row.answer === "string")
            .map((row) => ({ id: makeId(), question: row.question.trim(), answer: row.answer.trim() }));
          const existingBoard = boards.value.find(
            (board) => comparableText(board.name) === comparableText(name)
          );

          if (existingBoard) {
            for (const row of rows) {
              const alreadyExists = existingBoard.rows.some((existingRow) =>
                comparableText(existingRow.question) === comparableText(row.question)
              );
              if (!alreadyExists) {
                existingBoard.rows.push(row);
                addedRows += 1;
              }
            }
          } else {
            const uniqueRows = rows.filter((row, index) =>
              !rows.slice(0, index).some((previousRow) =>
                comparableText(previousRow.question) === comparableText(row.question)
              )
            );
            const board = { id: makeId(), name, rows: uniqueRows };
            boards.value.push(board);
            selectedBoardIds.value.push(board.id);
            addedBoards += 1;
            addedRows += uniqueRows.length;
          }
        }

        importMessage.value = `${addedBoards} liste${addedBoards > 1 ? "s" : ""} et ${addedRows} question${addedRows > 1 ? "s" : ""} ajoutée${addedRows > 1 ? "s" : ""}.`;
      } catch {
        importMessage.value = "Impossible d’importer ce fichier : il doit contenir un tableau JSON de listes.";
      }
    }

    function drawNextQuestion() {
      if (!remainingQuestions.value.length) {
        currentQuestion.value = null;
        phase.value = "finished";
        return;
      }
      const index = Math.floor(Math.random() * remainingQuestions.value.length);
      currentQuestion.value = remainingQuestions.value.splice(index, 1)[0];
      userAnswer.value = "";
      isCorrect.value = false;
      phase.value = "answering";
    }

    function rebuildSessionStock() {
      if (!availableQuestions.value.length) {
        remainingQuestions.value = [];
        currentQuestion.value = null;
        phase.value = "idle";
        return;
      }

      if (phase.value === "idle") {
        startSession();
        return;
      }

      const latestCurrentQuestion = currentQuestion.value && availableQuestions.value.find(
        (question) => question.id === currentQuestion.value.id
      );
      const currentIsSelected = Boolean(latestCurrentQuestion);
      const excludedIds = new Set(completedQuestionIds.value);
      if (currentIsSelected) excludedIds.add(currentQuestion.value.id);

      remainingQuestions.value = availableQuestions.value.filter((question) => !excludedIds.has(question.id));

      if (currentIsSelected) {
        currentQuestion.value = latestCurrentQuestion;
        return;
      }

      currentQuestion.value = null;
      userAnswer.value = "";
      drawNextQuestion();
    }

    function startSession() {
      completedQuestionIds.value = [];
      remainingQuestions.value = [...availableQuestions.value];
      currentQuestion.value = null;
      drawNextQuestion();
    }

    function revealAnswer() {
      if (phase.value !== "answering") return;

      isCorrect.value = comparableText(userAnswer.value) === comparableText(currentQuestion.value.answer);
      saveResult(isCorrect.value ? "success" : "fail");
      phase.value = "review";
    }

    function saveResult(outcome) {
      const question = currentQuestion.value.question;
      completedQuestionIds.value.push(currentQuestion.value.id);
      const previous = results.value[question] || { nb_display: 0, nb_success: 0, nb_fail: 0, las_result: "" };
      results.value = {
        ...results.value,
        [question]: {
          nb_display: previous.nb_display + 1,
          nb_success: previous.nb_success + (outcome === "success" ? 1 : 0),
          nb_fail: previous.nb_fail + (outcome === "fail" ? 1 : 0),
          las_result: outcome
        }
      };
    }

    function answerClass(answer) {
      const article = answer.trim().toLowerCase();
      const match = article.match(/^(der|die|das)(?:\s|$)/);
      return match ? `answer-${match[1]}` : "";
    }

    return {
      addBoard, addRow, answerClass, boards, currentQuestion, deleteBoard, deleteRow, exportBoards,
      drawNextQuestion, isCorrect, newBoardName, phase, remainingQuestions, resultEntries, revealAnswer,
      importBoards, importMessage, selectedBoardIds, selectAllBoards, startSession, storageError, usableRows, userAnswer, view
    };
  }
}).mount("#app");
