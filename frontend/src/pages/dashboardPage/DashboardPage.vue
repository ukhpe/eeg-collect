<script setup lang="ts">
import { ref, onMounted } from "vue";
import BasePage from "@/components/BasePage.vue";
import {
  PhPlus,
  PhCopy,
  PhCheck,
  PhFolder,
  PhWarningCircle,
} from "@phosphor-icons/vue";

// ---- TYPES ----
interface Study {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
}

// ---- STATE ----
const studies = ref<Study[]>([]);
const isLoading = ref(false);
const isCreating = ref(false);

// Modal State
const isCreateModalOpen = ref(false);
const newStudyTitle = ref("");
const newStudyDescription = ref("");

// Status für den Kopier-Button
const copiedStudyId = ref<string | null>(null);

const errorModal = ref({
  isOpen: false,
  title: "",
  message: "",
});

// User-Informationen aus localStorage
const userId = localStorage.getItem("user_id");

// ---- METHODS ----

const fetchStudies = async () => {
  if (!userId) return;

  isLoading.value = true;
  try {
    const response = await fetch(`http://localhost:3000/api/studies?userId=${userId}`);
    if (response.ok) {
      studies.value = await response.json();
    }
  } catch (error) {
    console.error("Fehler beim Laden der Studien:", error);
  } finally {
    isLoading.value = false;
  }
};

const handleCreateStudy = async () => {
  if (!newStudyTitle.value.trim()) return;

  isCreating.value = true;
  try {
    const response = await fetch("http://localhost:3000/api/studies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: newStudyTitle.value,
        description: newStudyDescription.value,
        userId: userId,
      }),
    });

    if (response.ok) {
      const createdStudy = await response.json();
      studies.value.unshift(createdStudy); // Setzt die neue Studie ganz nach oben in der Liste
      closeCreateModal();
    } else {
      showError("Fehler", "Studie konnte nicht erstellt werden.");
    }
  } catch (error) {
    showError("Verbindungsfehler", "Server ist nicht erreichbar.");
  } finally {
    isCreating.value = false;
  }
};

const closeCreateModal = () => {
  isCreateModalOpen.value = false;
  newStudyTitle.value = "";
  newStudyDescription.value = "";
};

const handleCopySessionLink = (studyId: string) => {
  const baseUrl = window.location.origin;
  const sessionUrl = `${baseUrl}/setup-device?studyId=${studyId}`;

  navigator.clipboard.writeText(sessionUrl).then(() => {
    copiedStudyId.value = studyId;
    setTimeout(() => {
      copiedStudyId.value = null;
    }, 2000);
  });
};

const showError = (title: string, message: string) => {
  errorModal.value = { isOpen: true, title, message };
};

onMounted(() => {
  fetchStudies();
});
</script>

<template>
  <BasePage heading="Researcher Dashboard">
    <p
      class="mb-6"
      style="
        color: #737373;
        text-align: center;
        font-weight: 500;
        font-size: 18px;
      "
    >
      Verwalte hier deine Studien und generiere Links für Probanden, <br />
      um neue Mess-Sessions zu starten.
    </p>

    <div class="dashboard-container">
      <!-- Header Aktion -->
      <div class="d-flex justify-space-between align-center mb-6">
        <h3 style="color: #333; font-weight: 600;">Deine Studien</h3>
        <VBtn
          color="#00594C"
          style="color: white;"
          :prepend-icon="PhPlus"
          @click="isCreateModalOpen = true"
        >
          Neue Studie
        </VBtn>
      </div>

      <!-- Ladeanzeige -->
      <div v-if="isLoading" class="text-center py-8">
        <v-progress-circular indeterminate color="#00594C"></v-progress-circular>
      </div>

      <!-- Leere Liste -->
      <div
        v-else-if="studies.length === 0"
        class="text-center py-8 px-4"
        style="background: #f9f9f9; border-radius: 12px; border: 1px dashed #ccc;"
      >
        <PhFolder :size="48" color="#939393" class="mb-2" />
        <p style="color: #737373; font-weight: 500;">
          Noch keine Studien vorhanden. Erstelle deine erste Studie!
        </p>
      </div>

      <!-- Liste der Studien -->
      <div v-else class="study-list">
        <v-card
          v-for="study in studies"
          :key="study.id"
          class="mb-3 pa-4 study-card"
          variant="outlined"
        >
          <div class="d-flex justify-space-between align-center">
            <div>
              <h4 style="font-size: 18px; color: #2c3e50; margin-bottom: 2px;">
                {{ study.title }}
              </h4>
              <p v-if="study.description" style="font-size: 14px; color: #737373; margin-bottom: 4px;">
                {{ study.description }}
              </p>
              <span style="font-size: 12px; color: #939393;">
                ID: {{ study.id }}
              </span>
            </div>

            <!-- Button: Link kopieren -->
            <VBtn
              variant="tonal"
              color="#00594C"
              :prepend-icon="copiedStudyId === study.id ? PhCheck : PhCopy"
              @click="handleCopySessionLink(study.id)"
            >
              {{ copiedStudyId === study.id ? 'Kopiert!' : 'Session-Link' }}
            </VBtn>
          </div>
        </v-card>
      </div>
    </div>
  </BasePage>

  <!-- Modal: Neue Studie erstellen -->
  <v-dialog v-model="isCreateModalOpen" max-width="500px" persistent>
    <v-card style="padding: 24px; border-radius: 12px;">
      <v-card-title class="px-0 pt-0 mb-2" style="font-weight: 600;">
        Neue Studie anlegen
      </v-card-title>

      <v-card-text class="px-0 py-2">
        <v-text-field
          v-model="newStudyTitle"
          label="Titel der Studie *"
          placeholder="z.B. Auditory EEG Pilot Study 2026"
          variant="outlined"
          density="comfortable"
          class="mb-4"
          hide-details="auto"
          @keyup.enter="handleCreateStudy"
        ></v-text-field>

        <v-textarea
          v-model="newStudyDescription"
          label="Beschreibung (Optional)"
          placeholder="Kurze Beschreibung des Forschungszieles..."
          variant="outlined"
          density="comfortable"
          rows="3"
          hide-details="auto"
        ></v-textarea>
      </v-card-text>

      <v-card-actions class="px-0 pb-0 mt-4" style="justify-content: end;">
        <VBtn
          variant="text"
          color="#737373"
          @click="closeCreateModal"
        >
          Abbrechen
        </VBtn>
        <VBtn
          color="#00594C"
          style="color: white;"
          :disabled="!newStudyTitle.trim()"
          :loading="isCreating"
          @click="handleCreateStudy"
        >
          Erstellen
        </VBtn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- Error Modal -->
  <v-dialog v-model="errorModal.isOpen" max-width="500px">
    <v-card style="padding: 16px; border-radius: 12px">
      <div style="display: flex; flex-direction: row; align-items: center">
        <PhWarningCircle :size="24" color="red" />
        <v-card-title class="pb-0 pl-2" style="text-align: left">
          {{ errorModal.title }}
        </v-card-title>
      </div>

      <v-card-text class="px-8 mb-1" style="text-align: left">
        {{ errorModal.message }}
      </v-card-text>

      <v-card-actions class="pb-0" style="justify-content: end">
        <VBtn @click="errorModal.isOpen = false" rounded="lg">Schließen</VBtn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dashboard-container {
  width: 100%;
  max-width: 750px;
  margin: 0 auto;
}

.study-card {
  border-radius: 10px;
  border-color: #e2e8f0;
  transition: all 0.2s ease;
}

.study-card:hover {
  border-color: #00594C;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}
</style>