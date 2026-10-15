<script setup lang="ts">
import { ref, onMounted } from "vue";
import BasePage from "@/components/BasePage.vue";
import { URL_PARAMS, getEncodedPassphrase } from "@/utils/helpers";
import {
  PhPlus,
  PhCopy,
  PhCheck,
  PhFolder,
  PhWarningCircle,
  PhTrash,
  PhUserPlus,
  PhDownloadSimple,
} from "@phosphor-icons/vue";

// ---- TYPES ----
interface Study {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  _count?: { sessions: number };
}

// ---- STATE ----
const studies = ref<Study[]>([]);
const isLoading = ref(false);
const isCreating = ref(false);

// Modal State
const isCreateModalOpen = ref(false);
const newStudyTitle = ref("");
const newStudyDescription = ref("");

// Delete Modal State
const isDeleteModalOpen = ref(false);
const isDeleting = ref(false);
const studyToDelete = ref<Study | null>(null);
const deleteConfirmationTitle = ref("");

// Status for the copy button
const copiedStudyId = ref<string | null>(null);

const errorModal = ref({
  isOpen: false,
  title: "",
  message: "",
});

// User information from localStorage
const userId = localStorage.getItem("user_id");
const isAdmin = localStorage.getItem("is_admin") === "true";

const authHeaders = () => ({
  Authorization: `Bearer ${localStorage.getItem("user_token")}`,
});

// Create User Modal State
const isCreateUserModalOpen = ref(false);
const isCreatingUser = ref(false);
const newUsername = ref("");
const newUserPassword = ref("");
const newUserIsAdmin = ref(false);

// ---- METHODS ----

const fetchStudies = async () => {
  if (!userId) return;

  isLoading.value = true;
  try {
    const response = await fetch("http://localhost:3000/api/studies/list", {
      headers: authHeaders(),
    });
    if (response.ok) {
      studies.value = await response.json();
    }
  } catch (error) {
    console.error("Error loading studies:", error);
  } finally {
    isLoading.value = false;
  }
};

const handleCreateStudy = async () => {
  if (!newStudyTitle.value.trim()) return;

  isCreating.value = true;
  try {
    const response = await fetch("http://localhost:3000/api/studies/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        title: newStudyTitle.value,
        description: newStudyDescription.value,
      }),
    });

    if (response.ok) {
      const createdStudy = await response.json();
      studies.value.unshift(createdStudy); // Puts the new study at the top of the list
      closeCreateModal();
    } else {
      showError("Error", "Study could not be created.");
    }
  } catch (error) {
    showError("Connection Error", "Server is not reachable.");
  } finally {
    isCreating.value = false;
  }
};

const closeCreateModal = () => {
  isCreateModalOpen.value = false;
  newStudyTitle.value = "";
  newStudyDescription.value = "";
};

const openDeleteModal = (study: Study) => {
  studyToDelete.value = study;
  isDeleteModalOpen.value = true;
};

const closeDeleteModal = () => {
  isDeleteModalOpen.value = false;
  studyToDelete.value = null;
  deleteConfirmationTitle.value = "";
};

const handleDeleteStudy = async () => {
  if (!studyToDelete.value) return;
  if (deleteConfirmationTitle.value !== studyToDelete.value.title) return;

  isDeleting.value = true;
  try {
    const response = await fetch(
      `http://localhost:3000/api/studies/${studyToDelete.value.id}/delete`,
      { method: "DELETE", headers: authHeaders() },
    );

    if (response.ok) {
      studies.value = studies.value.filter(
        (study) => study.id !== studyToDelete.value!.id,
      );
      closeDeleteModal();
    } else {
      showError("Error", "Study could not be deleted.");
    }
  } catch (error) {
    showError("Connection Error", "Server is not reachable.");
  } finally {
    isDeleting.value = false;
  }
};

const closeCreateUserModal = () => {
  isCreateUserModalOpen.value = false;
  newUsername.value = "";
  newUserPassword.value = "";
  newUserIsAdmin.value = false;
};

const handleCreateUser = async () => {
  if (!newUsername.value.trim() || !newUserPassword.value.trim()) return;

  isCreatingUser.value = true;
  try {
    const response = await fetch("http://localhost:3000/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        username: newUsername.value,
        password: newUserPassword.value,
        isAdmin: newUserIsAdmin.value,
      }),
    });

    if (response.ok) {
      closeCreateUserModal();
    } else {
      const data = await response.json();
      showError("Error", data.message || "User could not be created.");
    }
  } catch (error) {
    showError("Connection Error", "Server is not reachable.");
  } finally {
    isCreatingUser.value = false;
  }
};

const handleDownloadStudyData = async (studyId: string) => {
  try {
    const response = await fetch(
      `http://localhost:3000/api/studies/${studyId}/download`,
      { headers: authHeaders() },
    );

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const detail = data?.error || data?.message;
      showError(
        "Error",
        `Study data could not be downloaded. (${response.status}${detail ? `: ${detail}` : ""})`,
      );
      return;
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `study-${studyId}.zip`;
    link.click();
    window.URL.revokeObjectURL(downloadUrl);
  } catch (error) {
    showError("Connection Error", "Server is not reachable.");
  }
};

const handleCopySessionLink = (studyId: string) => {
  const baseUrl = window.location.origin;
  const params = new URLSearchParams({
    [URL_PARAMS.passPhrase]: getEncodedPassphrase(),
    [URL_PARAMS.channelConfig]: "E",
    [URL_PARAMS.studyIdParam]: studyId,
  });
  const sessionUrl = `${baseUrl}/optimize-signal?${params.toString()}`;

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
      Manage your studies here and generate links for participants <br />
      to start new measurement sessions.
    </p>

    <div class="dashboard-container">
      <!-- Header Action -->
      <div class="d-flex justify-space-between align-center mb-6">
        <h3 style="color: #333; font-weight: 600;">Your Studies</h3>
        <div class="d-flex align-center" style="gap: 8px;">
          <VBtn
            v-if="isAdmin"
            variant="tonal"
            color="#00594C"
            :prepend-icon="PhUserPlus"
            @click="isCreateUserModalOpen = true"
          >
            Create new user
          </VBtn>
          <VBtn
            color="#00594C"
            style="background-color: #00594C; color: white;"
            :prepend-icon="PhPlus"
            @click="isCreateModalOpen = true"
          >
            Create new study
          </VBtn>
        </div>
      </div>

      <!-- Loading Indicator -->
      <div v-if="isLoading" class="text-center py-8">
        <v-progress-circular indeterminate color="#00594C"></v-progress-circular>
      </div>

      <!-- Empty List -->
      <div
        v-else-if="studies.length === 0"
        class="text-center py-8 px-4"
        style="background: #f9f9f9; border-radius: 12px; border: 1px dashed #ccc;"
      >
        <PhFolder :size="48" color="#939393" class="mb-2" />
        <p style="color: #737373; font-weight: 500;">
          No studies yet. Create your first study!
        </p>
      </div>

      <!-- List of Studies -->
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
                ID: {{ study.id }} &middot; {{ study._count?.sessions ?? 0 }}
                {{ study._count?.sessions === 1 ? 'Session' : 'Sessions' }}
              </span>
            </div>

            <div class="d-flex align-center" style="gap: 8px;">
              <!-- Button: Copy Link -->
              <VBtn
                variant="tonal"
                color="#00594C"
                :prepend-icon="copiedStudyId === study.id ? PhCheck : PhCopy"
                @click="handleCopySessionLink(study.id)"
              >
                {{ copiedStudyId === study.id ? 'Copied!' : 'Session Link' }}
              </VBtn>

              <!-- Button: Download Study Data -->
              <VBtn
                variant="tonal"
                color="#00594C"
                icon
                :width="40"
                :height="40"
                @click="handleDownloadStudyData(study.id)"
              >
                <PhDownloadSimple :size="18" />
              </VBtn>

              <!-- Button: Delete Study -->
              <VBtn
                variant="tonal"
                color="red"
                icon
                :width="40"
                :height="40"
                @click="openDeleteModal(study)"
              >
                <PhTrash :size="18" />
              </VBtn>
            </div>
          </div>
        </v-card>
      </div>
    </div>
  </BasePage>

  <!-- Modal: Create New Study -->
  <v-dialog v-model="isCreateModalOpen" max-width="500px" persistent>
    <v-card style="padding: 24px; border-radius: 12px;">
      <v-card-title class="px-0 pt-0 mb-2" style="font-weight: 600;">
        Create New Study
      </v-card-title>

      <v-card-text class="px-0 py-2">
        <v-text-field
          v-model="newStudyTitle"
          label="Study Title *"
          placeholder="e.g. Auditory EEG Pilot Study 2026"
          variant="outlined"
          density="comfortable"
          class="mb-4"
          hide-details="auto"
          @keyup.enter="handleCreateStudy"
        ></v-text-field>

        <v-textarea
          v-model="newStudyDescription"
          label="Description (Optional)"
          placeholder="Short description of the research goal..."
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
          Cancel
        </VBtn>
        <VBtn
          color="#00594C"
          style="background-color: #00594C; color: white;"
          :disabled="!newStudyTitle.trim()"
          :loading="isCreating"
          @click="handleCreateStudy"
        >
          Create new study
        </VBtn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- Modal: Create New User -->
  <v-dialog v-model="isCreateUserModalOpen" max-width="500px" persistent>
    <v-card style="padding: 24px; border-radius: 12px;">
      <v-card-title class="px-0 pt-0 mb-2" style="font-weight: 600;">
        Create New User
      </v-card-title>

      <v-card-text class="px-0 py-2">
        <v-text-field
          v-model="newUsername"
          label="Username *"
          variant="outlined"
          density="comfortable"
          class="mb-4"
          hide-details="auto"
        ></v-text-field>

        <v-text-field
          v-model="newUserPassword"
          label="Password *"
          type="password"
          variant="outlined"
          density="comfortable"
          class="mb-4"
          hide-details="auto"
          @keyup.enter="handleCreateUser"
        ></v-text-field>

        <v-checkbox
          v-model="newUserIsAdmin"
          label="Grant admin rights"
          density="comfortable"
          hide-details="auto"
        ></v-checkbox>
      </v-card-text>

      <v-card-actions class="px-0 pb-0 mt-4" style="justify-content: end;">
        <VBtn
          variant="text"
          color="#737373"
          @click="closeCreateUserModal"
        >
          Cancel
        </VBtn>
        <VBtn
          color="#00594C"
          style="background-color: #00594C; color: white;"
          :disabled="!newUsername.trim() || !newUserPassword.trim()"
          :loading="isCreatingUser"
          @click="handleCreateUser"
        >
          Create new user
        </VBtn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- Modal: Delete Study -->
  <v-dialog v-model="isDeleteModalOpen" max-width="500px">
    <v-card style="padding: 24px; border-radius: 12px;">
      <v-card-title class="px-0 pt-0 mb-2" style="font-weight: 600;">
        Delete Study
      </v-card-title>

      <v-card-text class="px-0 py-2">
        Do you really want to delete the study "{{ studyToDelete?.title }}"?
        This action cannot be undone.

        <v-text-field
          v-model="deleteConfirmationTitle"
          :label="`Type &quot;${studyToDelete?.title}&quot; to confirm`"
          variant="outlined"
          density="comfortable"
          class="mt-4"
          hide-details="auto"
          @keyup.enter="handleDeleteStudy"
        ></v-text-field>
      </v-card-text>

      <v-card-actions class="px-0 pb-0 mt-4" style="justify-content: end;">
        <VBtn
          variant="text"
          color="#737373"
          @click="closeDeleteModal"
        >
          Cancel
        </VBtn>
        <VBtn
          color="red"
          style="background-color: #c62828; color: white;"
          :disabled="deleteConfirmationTitle !== studyToDelete?.title"
          :loading="isDeleting"
          @click="handleDeleteStudy"
        >
          Delete
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
        <VBtn @click="errorModal.isOpen = false" rounded="lg">Close</VBtn>
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