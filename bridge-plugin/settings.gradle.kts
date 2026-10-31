plugins {
    // Lets Gradle auto-download the Java 21 toolchain (Gradle itself may run on Java 11+).
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}

rootProject.name = "survivors-bridge"
