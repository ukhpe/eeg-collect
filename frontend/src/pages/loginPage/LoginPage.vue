<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import BasePage from "@/components/BasePage.vue";
import { PhSignIn, PhWarningCircle } from "@phosphor-icons/vue";

// ---- STATE ----
const username = ref("");
const password = ref("");
const isLoading = ref(false);

const errorModal = ref({
  isOpen: false,
  title: "",
  message: "",
});

const router = useRouter();

// ---- METHODS ----
const handleLogin = async () => {
  if (!username.value || !password.value) {
    errorModal.value = {
      isOpen: true,
      title: "Fehlende Eingaben",
      message: "Bitte gib Benutzername und Passwort ein.",
    };
    return;
  }

  isLoading.value = true;

  try {
    const response = await fetch("http://localhost:3000/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username.value,
        password: password.value,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      // Token & User-Informationen lokal speichern
      localStorage.setItem("user_token", data.token);
      localStorage.setItem("user_id", data.userId);
      localStorage.setItem("username", data.username);

      // Weiterleitung zum geschützten Dashboard
      router.push("/dashboard");
    } else {
      errorModal.value = {
        isOpen: true,
        title: "Anmeldung fehlgeschlagen",
        message: data.message || "Ungültige Anmeldedaten. Bitte versuche es erneut.",
      };
    }
  } catch (error) {
    errorModal.value = {
      isOpen: true,
      title: "Verbindungsfehler",
      message: "Der Server ist aktuell nicht erreichbar.",
    };
  } finally {
    isLoading.value = false;
  }
};
</script>

<template>
  <BasePage heading="Researcher Login">
    <p
      class="mb-8"
      style="
        color: #737373;
        text-align: center;
        font-weight: 500;
        font-size: 18px;
      "
    >
      Bitte melde dich an, um Zugriff auf die Studienverwaltung und <br />
      das Dashboard zu erhalten.
    </p>

    <!-- Login Formular Container -->
    <div class="login-form-container">
      <form @submit.prevent="handleLogin">
        <v-text-field
          v-model="username"
          label="Benutzername"
          variant="outlined"
          density="comfortable"
          class="mb-2"
          hide-details="auto"
        ></v-text-field>

        <v-text-field
          v-model="password"
          label="Passwort"
          type="password"
          variant="outlined"
          density="comfortable"
          class="mb-6"
          hide-details="auto"
        ></v-text-field>

        <VBtn
          type="submit"
          class="w-100"
          :append-icon="PhSignIn"
          :loading="isLoading"
        >
          Anmelden
        </VBtn>
      </form>
    </div>

    <p
      class="mt-4"
      style="
        font-size: 13px;
        color: #939393;
        text-align: center;
        max-width: 600px;
      "
    >
      Zugang nur für autorisierte Testleiter und Researcher. <br />
      Probanden benötigen keine Anmeldung und nutzen den zugewiesenen Link.
    </p>
  </BasePage>

  <!-- Loading Dialog -->
  <v-dialog v-model="isLoading" max-width="500px" persistent>
    <v-card style="padding: 40px; border-radius: 12px; align-items: center">
      <v-progress-circular
        indeterminate
        :size="41"
        :width="5"
        color="#00594C"
        style="margin-bottom: 8px"
      ></v-progress-circular>
      <v-card-text style="padding-bottom: 0">
        Anmeldung wird überprüft...
      </v-card-text>
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
.login-form-container {
  width: 100%;
  max-width: 420px;
  margin: 0 auto 24px auto;
}
</style>